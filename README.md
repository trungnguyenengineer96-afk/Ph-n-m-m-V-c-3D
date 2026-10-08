# CAD Viewer 3D

Phần mềm xem và đánh giá mô hình CAD chạy trên trình duyệt, giao diện theo kiểu SolidWorks. Phần mềm đọc được tệp **STEP/IGES**, tệp gốc **SolidWorks** (`.SLDPRT`, `.SLDASM`, `.SLDDRW`) và bản vẽ **DXF**. Các chức năng chính:

- **Đo (Measure)**: đo đỉnh, cạnh và mặt. Kết quả gồm khoảng cách, góc, đường kính/bán kính, khoảng cách tâm–tâm và trục–mặt, khoảng cách nhỏ nhất, diện tích, chiều dài.
- **Mặt cắt (Section View)**: tối đa 3 mặt cắt X/Y/Z hoặc mặt cắt theo một mặt phẳng chọn trên mô hình. Có thể xoay góc mặt cắt. Phần bị cắt được tô và gạch (hatch).
- **Tách rời (Exploded View)**: tách tạm thời theo cụm, chi tiết hoặc thân, toả từ tâm hoặc theo trục X/Y/Z. Có hoạt cảnh tách/gộp và gizmo để kéo từng chi tiết. Nút *Reset* đưa mô hình về như cũ, tệp gốc không bị thay đổi.
- **Thuộc tính khối lượng**: khối lượng theo vật liệu, thể tích, diện tích, trọng tâm, mô-men quán tính chính, ten-xơ quán tính, kích thước bao.
- **Cây mô hình (FeatureManager)**: ẩn/hiện, cô lập (isolate), trong suốt, phóng tới từng thành phần.
- **Hiển thị**: hướng nhìn chuẩn (Front/Top/Right/Iso…), *Normal To*, phối cảnh/trực giao, kiểu hiển thị Shaded with Edges / Shaded / Hidden Lines Removed / Wireframe / Trong suốt.
- **Xuất**: ảnh PNG, STL, glTF/GLB. Có thể dùng để chuyển SLDPRT sang STL.
- Mở nhiều tài liệu cùng lúc theo tab, kéo thả tệp hoặc cả thư mục.

## Dựng hình (Part modeling)

Bấm **Chi tiết mới** để dựng một chi tiết theo cây feature tham số như SolidWorks:

1. Chọn mặt phẳng trong cây (Front / Top / Right), hoặc nhấp một mặt phẳng trên mô hình, rồi bấm **Sketch**.
2. Vẽ bằng **Đường thẳng, Đường tâm, Chữ nhật, Tròn, Cung 3 điểm**. Con trỏ tự bắt điểm, và tự thêm quan hệ Ngang/Dọc khi vẽ gần ngang/dọc.
3. **Kích thước thông minh**:
   - Nhấp đường → chiều dài.
   - Nhấp tròn → đường kính; nhấp cung → bán kính.
   - Nhấp 2 điểm → khoảng cách (thẳng/ngang/dọc); nhấp 2 đường → góc.
   - Nhấp đúp vào kích thước để sửa giá trị.
4. **Quan hệ**: chọn đối tượng (Ctrl+nhấp), rồi chọn Song song, Vuông góc, Bằng nhau, Tiếp tuyến, Đồng tâm, Trung điểm, Cố định…
5. Bộ giải ràng buộc (planegcs của FreeCAD) giải lại sau mỗi thay đổi. Thanh trạng thái báo *Đã xác định đủ* hoặc số bậc tự do còn lại.
6. **Thoát Sketch**, rồi dùng **Đùn khối / Cắt đùn** (Blind, Through All, Mid Plane), **Xoay khối / Cắt xoay** (trục là đường tâm), **Bo tròn**, **Vát cạnh** (nhấp cạnh trên mô hình), **Vỏ** (nhấp mặt cần mở) hoặc **Đối xứng**.
7. Trong cây feature: nhấp đúp để sửa, chuột phải để tạm tắt / đổi tên / xoá. Mọi thay đổi được tính lại toàn bộ (tham số). Có Hoàn tác / Làm lại (Ctrl+Z / Ctrl+Y).
8. **Lưu .cvpart** để mở lại và sửa tiếp. **Xuất STEP** để mở trong SolidWorks hoặc phần mềm CAD khác, **Xuất STL** để in 3D.

Phím tắt trong sketch: `L` đường, `R` chữ nhật, `C` tròn, `A` cung, `D` kích thước, `S` chọn, `Delete` xoá, `Esc` kết thúc lệnh / thoát sketch.

Lõi hình học là OpenCascade (qua thư viện replicad). Lõi này được tải riêng khoảng 23 MB, chỉ tải lần đầu dựng hình.

## Định dạng hỗ trợ

| Định dạng | Đọc được | Ghi chú |
|---|---|---|
| STEP `.step/.stp` (AP203/AP214/AP242) | Hình học B-rep chính xác, cây lắp ráp, vị trí, màu | Dùng OpenCascade (WebAssembly) |
| IGES `.igs/.iges`, BREP `.brep` | Hình học, màu | OpenCascade |
| SolidWorks Part `.SLDPRT` (2011 →) | Lưới hiển thị đúng như SolidWorks lưu, cạnh B-rep, loại mặt (phẳng/trụ/côn) với **bán kính chính xác**, nhiều thân, ảnh xem trước, thuộc tính tuỳ biến | Đọc trực tiếp, không cần cài SolidWorks |
| SolidWorks Assembly `.SLDASM` (2015 →) | Cây lắp ráp đầy đủ (cụm con, cấu hình đang dùng), **vị trí từng chi tiết** và lưới hình học lưu sẵn trong tệp. Hiển thị được lắp ráp **không cần tệp chi tiết**. Chi tiết nào thiếu lưới thì mở kèm `.SLDPRT` (hoặc STEP cùng tên) để tự nạp vào đúng vị trí | Màu/appearance chưa đọc được |
| SolidWorks Drawing `.SLDDRW` | Toàn bộ các trang bản vẽ (ảnh trang lưu trong tệp), chuyển trang bằng thanh tab hoặc PageUp/PageDown | Nét vector chưa giải mã được; ảnh trang có độ phân giải 640×480 do SolidWorks lưu |
| DXF `.dxf` | LINE, (LW)POLYLINE có bulge, CIRCLE, ARC, ELLIPSE, SPLINE, TEXT/MTEXT, INSERT (block), DIMENSION | Đo trên bản vẽ 2D |
| STL, OBJ, glTF/GLB, 3MF, PLY | Lưới tam giác | "Mặt" được nhận dạng theo góc pháp tuyến |

## Chạy phần mềm

Cần Node.js 18 trở lên.

```bash
npm install
npm run dev        # chạy thử: mở http://localhost:5173
npm run build      # đóng gói vào thư mục dist/
npm run preview    # xem bản đã đóng gói
npm test           # chạy kiểm thử tự động
```

Thư mục `dist/` là trang web tĩnh, có thể đặt lên bất kỳ máy chủ web nào (IIS, Nginx, GitHub Pages…) hoặc mạng nội bộ. Mọi tệp được xử lý ngay trên máy người dùng, **không tải lên máy chủ**.

Trên thanh công cụ có menu **Tệp mẫu** gồm một lắp ráp STEP, các chi tiết SolidWorks và một bản vẽ DXF để thử ngay.

## Thao tác

| Thao tác | Chức năng |
|---|---|
| Kéo chuột trái hoặc chuột giữa | Xoay quanh điểm dưới con trỏ (dấu chấm đỏ là tâm xoay) |
| Kéo chuột phải, Ctrl + chuột giữa | Di chuyển (pan) |
| Con lăn, Shift + kéo chuột giữa | Phóng to/thu nhỏ tại vị trí con trỏ |
| `←` `→` `↑` `↓` (giữ Shift: 90°) | Xoay 15° |
| `Alt` + `←` `→` | Xoay quanh hướng nhìn (roll) |
| Nhấp đúp vào mặt | Nhìn vuông góc (Normal To) |
| Chuột phải (không kéo) | Menu: Ẩn / Cô lập / Trong suốt / Normal To |
| `F` | Vừa màn hình |
| `1`…`7` | Front, Back, Left, Right, Top, Bottom, Isometric |
| `8` | Normal To mặt đã chọn |
| `P` | Bật/tắt phối cảnh |
| `M` / `S` / `E` | Đo / Mặt cắt / Tách rời |
| `h` / `Shift+H` | Ẩn thành phần đang chọn / Hiện tất cả |
| `T` / `R` | Gizmo tịnh tiến / xoay (khi tách rời) |
| `Ctrl+O` | Mở tệp |
| `Esc` | Thoát công cụ |

*Cài đặt* có thêm lựa chọn kiểu xoay (tự do như SolidWorks, hoặc bàn xoay giữ trục Y thẳng đứng), tốc độ xoay và chiều con lăn.

Đo: nhấp chọn đỉnh, cạnh hoặc mặt (con trỏ tự bắt điểm). Ctrl + nhấp để chọn thêm đối tượng thứ hai. Chọn ≥ 3 đối tượng để xem tổng diện tích hoặc tổng chiều dài.

## Giới hạn

Định dạng SolidWorks là định dạng độc quyền và không có tài liệu công khai. Phần mềm này đọc những phần đã được nghiên cứu công khai:

- **SLDPRT**: hình hiển thị là lưới tam giác do SolidWorks lưu sẵn. Vì vậy đo trên mặt cong là đo trên lưới, trừ mặt trụ và mặt côn: bán kính của chúng lấy chính xác từ tệp. Không đọc được cây feature, sketch hay cấu hình. Tệp trước SolidWorks 2011 chỉ hiện được ảnh xem trước.
- **SLDASM**: đọc được cây thành phần, vị trí và lưới lưu sẵn (cấu trúc `COMPINSTANCETREE` và `FaceTessellations`, kiểm chứng trên tệp SolidWorks 2023). Chưa đọc được ràng buộc (mates) dưới dạng có thể chỉnh sửa, và chưa đọc được màu.
- **SLDDRW**: hiển thị ảnh các trang bản vẽ lưu trong tệp. Để đo trên bản vẽ, hãy xuất **DXF**. DWG chưa được hỗ trợ.
- Thể tích và khối lượng tính trên lưới tam giác. Sai số phụ thuộc độ mịn lưới, chỉnh trong *Cài đặt → Độ mịn lưới* cho STEP/IGES.

- **Dựng hình** mới ở giai đoạn 1–2: sketch, Extrude, Revolve, Cut, Fillet, Chamfer, Shell, Mirror. Chưa có: Sweep/Loft, Pattern, Hole Wizard, Trim/Offset trong sketch, lắp ráp có ràng buộc, tạo bản vẽ 2D từ mô hình. Cạnh/mặt cho Fillet/Shell được tham chiếu theo vị trí, nên khi sửa kích thước làm cạnh dịch chuyển xa thì cần chọn lại.

## Cấu trúc mã nguồn

```
src/
  core/        kiểu dữ liệu, hình học (khớp mặt/cạnh), đo đạc, khối lượng, đơn vị
  loaders/     STEP/IGES (OpenCascade worker), SolidWorks (sw/), DXF, lưới tam giác
  viewer/      Three.js: Viewer, DocumentView, Picker (bắt điểm), Section, Explode, Highlight
  tools/       công cụ Đo
  ui/          cây mô hình, các bảng thuộc tính (PropertyManager)
  app/         điều phối ứng dụng, liên kết lắp ráp SLDASM
  modeling/    dựng hình: kiểu dữ liệu feature, trình vẽ sketch, bộ giải ràng buộc, lõi OpenCascade (worker)
public/occt/   worker OpenCascade (tệp wasm được chép tự động khi build)
public/samples tệp mẫu
tests/         kiểm thử (vitest)
```

## Giấy phép và nguồn tham khảo

- [three.js](https://threejs.org) (MIT), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT), [dxf-parser](https://github.com/gdsestimating/dxf-parser) (MIT), [pako](https://github.com/nodeca/pako) (MIT/Zlib), [cfb](https://github.com/SheetJS/js-cfb) (Apache-2.0).
- [replicad](https://github.com/sgenoud/replicad) (MIT) với bản dựng OpenCascade `replicad-opencascadejs` (LGPL-2.1); [planegcs](https://github.com/Salusoft89/planegcs) — bộ giải ràng buộc của FreeCAD (LGPL-2.0+).
- [occt-import-js](https://github.com/kovacsv/occt-import-js) và [Open CASCADE Technology](https://dev.opencascade.org) (LGPL-2.1), được nạp dưới dạng thư viện động (WebAssembly riêng).
- Cấu trúc tệp SolidWorks theo nghiên cứu công khai [blussyya/sldprt-converter](https://github.com/blussyya/sldprt-converter) (MIT) và [KenM76/swformat](https://github.com/KenM76/swformat). Bộ đọc trong `src/loaders/sw/` được viết lại bằng TypeScript. Các tệp `.SLDPRT` mẫu lấy từ sldprt-converter (MIT, xem `public/samples/LICENSE-sldprt-samples.txt`).
- `as1_pe_203_assembly.stp` là mô hình thử nghiệm công khai của CAx-IF, lấy theo bộ kiểm thử của occt-import-js.
