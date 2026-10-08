/* Classic worker wrapping occt-import-js (OpenCascade compiled to WebAssembly).
 * Request:  { id, format: 'step'|'iges'|'brep', buffer: ArrayBuffer, params }
 * Response: { id, result } or { id, error } */
importScripts('occt-import-js.js');

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({
      locateFile: (path) => new URL(path, self.location.href).href,
    });
  }
  return occtPromise;
}

onmessage = async (ev) => {
  const { id, format, buffer, params } = ev.data;
  try {
    const occt = await getOcct();
    const content = new Uint8Array(buffer);
    let result;
    if (format === 'step') result = occt.ReadStepFile(content, params);
    else if (format === 'iges') result = occt.ReadIgesFile(content, params);
    else if (format === 'brep') result = occt.ReadBrepFile(content, params);
    else throw new Error('Định dạng không hỗ trợ: ' + format);
    if (!result || !result.success) throw new Error('OpenCascade không đọc được tệp (tệp hỏng hoặc không phải ' + format.toUpperCase() + ').');
    // Convert plain arrays to typed arrays so they can be transferred cheaply.
    const transfer = [];
    for (const m of result.meshes) {
      const pos = new Float32Array(m.attributes.position.array);
      const nor = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const idx = new Uint32Array(m.index.array);
      m.attributes.position.array = pos;
      if (nor) m.attributes.normal.array = nor;
      m.index.array = idx;
      transfer.push(pos.buffer, idx.buffer);
      if (nor) transfer.push(nor.buffer);
    }
    postMessage({ id, result }, transfer);
  } catch (e) {
    postMessage({ id, error: (e && e.message) || String(e) });
  }
};
