// cvimport — native STEP/IGES/BREP importer for the CAD Viewer 3D desktop app.
//
// Reads a CAD file with OpenCascade (XCAF: names, colours, assembly
// structure), meshes it with BRepMesh in parallel and writes a compact binary
// file the app loads directly:
//
//   "CVMESH01" | u32 jsonLength | json (UTF-8) | padding to 4 | binary arrays
//
// The JSON mirrors the occt-import-js result used by the web build
// (root node tree + meshes with brep_faces), plus a per-node 4x4 matrix so
// repeated parts are stored once. Array references are [byteOffset, count]
// into the binary section (float32 positions/normals, uint32 indices).
//
// Usage: cvimport <input> <output> [linearDeflectionRatio=0.001] [angularDeflection=0.5]
// Exit code 0 on success; errors are printed to stderr.

#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom_Surface.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <IGESCAFControl_Reader.hxx>
#include <Interface_Static.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_Color.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <gp_Trsf.hxx>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct Color {
  bool set = false;
  double r = 0, g = 0, b = 0;
};

struct FaceRange {
  int first, last;
  Color color;
};

struct Mesh {
  std::string name;
  Color color;
  std::vector<float> pos, nor;
  std::vector<uint32_t> idx;
  std::vector<FaceRange> faces;
};

struct Node {
  std::string name;
  double matrix[16];  // column-major, relative to parent
  bool hasMatrix = false;
  std::vector<int> meshes;
  std::vector<Node> children;
};

Handle(XCAFDoc_ShapeTool) gShapes;
Handle(XCAFDoc_ColorTool) gColors;
std::vector<Mesh> gMeshes;
std::map<int, int> gMeshOfLabel;  // label tag hash → mesh index (shared parts)

std::string jsonEscape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          o += buf;
        } else o += static_cast<char>(c);
    }
  }
  return o;
}

std::string labelName(const TDF_Label& label) {
  Handle(TDataStd_Name) attr;
  if (!label.FindAttribute(TDataStd_Name::GetID(), attr)) return "";
  TCollection_AsciiString ascii(attr->Get(), '?');
  // Convert to UTF-8 properly.
  const TCollection_ExtendedString& ext = attr->Get();
  std::string out;
  out.resize(ext.LengthOfCString() + 1);
  Standard_PCharacter p = out.data();
  int n = ext.ToUTF8CString(p);
  out.resize(n > 0 ? n : 0);
  return out.empty() ? std::string(ascii.ToCString()) : out;
}

Color colorOf(const TDF_Label& label) {
  Color c;
  Quantity_Color q;
  if (gColors->GetColor(label, XCAFDoc_ColorSurf, q) || gColors->GetColor(label, XCAFDoc_ColorGen, q)) {
    double r, g, b;
    q.Values(r, g, b, Quantity_TOC_sRGB);
    c.set = true;
    c.r = r, c.g = g, c.b = b;
  }
  return c;
}

Color colorOfShape(const TopoDS_Shape& s) {
  Color c;
  Quantity_Color q;
  if (gColors->GetColor(s, XCAFDoc_ColorSurf, q) || gColors->GetColor(s, XCAFDoc_ColorGen, q)) {
    double r, g, b;
    q.Values(r, g, b, Quantity_TOC_sRGB);
    c.set = true;
    c.r = r, c.g = g, c.b = b;
  }
  return c;
}

void toMatrix(const TopLoc_Location& loc, double m[16]) {
  const gp_Trsf t = loc.Transformation();
  for (int c = 0; c < 4; c++)
    for (int r = 0; r < 4; r++) m[c * 4 + r] = (r == 3) ? (c == 3 ? 1.0 : 0.0) : t.Value(r + 1, c + 1);
}

// Triangulate a part shape (in its own coordinates) into one mesh.
int buildMesh(const TDF_Label& label, const TopoDS_Shape& shape, const std::string& name) {
  Mesh mesh;
  mesh.name = name;
  mesh.color = colorOf(label);
  for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Face& face = TopoDS::Face(ex.Current());
    TopLoc_Location loc;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
    if (tri.IsNull() || tri->NbTriangles() == 0) continue;
    const gp_Trsf trsf = loc.Transformation();
    const bool reversed = face.Orientation() == TopAbs_REVERSED;
    const uint32_t base = static_cast<uint32_t>(mesh.pos.size() / 3);
    const int nn = tri->NbNodes();
    // Normals: exact surface normal at each node's UV where defined, else the
    // average of the adjacent triangle normals (poles, degenerate points).
    std::vector<gp_Vec> nrm(nn + 1, gp_Vec(0, 0, 0));
    for (int i = 1; i <= tri->NbTriangles(); i++) {
      int a, b, c;
      tri->Triangle(i).Get(a, b, c);
      const gp_Pnt pa = tri->Node(a), pb = tri->Node(b), pc = tri->Node(c);
      const gp_Vec fn = gp_Vec(pa, pb).Crossed(gp_Vec(pa, pc));
      nrm[a] += fn;
      nrm[b] += fn;
      nrm[c] += fn;
    }
    TopLoc_Location sloc;
    Handle(Geom_Surface) surf = BRep_Tool::Surface(face, sloc);
    const bool useSurf = !surf.IsNull() && tri->HasUVNodes();
    GeomLProp_SLProps props(1, 1e-9);
    if (useSurf) props.SetSurface(surf);
    // Surface normals are in the surface's frame; triangulation nodes in the
    // triangulation's frame. Bring surface normals into the latter.
    const gp_Trsf s2t = trsf.Inverted().Multiplied(sloc.Transformation());
    for (int i = 1; i <= nn; i++) {
      gp_Pnt p = tri->Node(i).Transformed(trsf);
      mesh.pos.push_back(static_cast<float>(p.X()));
      mesh.pos.push_back(static_cast<float>(p.Y()));
      mesh.pos.push_back(static_cast<float>(p.Z()));
      gp_Vec v = nrm[i];
      if (useSurf) {
        const gp_Pnt2d uv = tri->UVNode(i);
        props.SetParameters(uv.X(), uv.Y());
        if (props.IsNormalDefined()) {
          gp_Vec sv(props.Normal());
          sv.Transform(s2t);
          // Guard against surfaces whose parametrisation flips the normal
          // relative to the triangle winding.
          v = (v.SquareMagnitude() > 0 && sv.Dot(v) < 0) ? -sv : sv;
        }
      }
      gp_Dir n = v.SquareMagnitude() > 1e-30 ? gp_Dir(v) : gp_Dir(0, 0, 1);
      n.Transform(trsf);
      if (reversed) n.Reverse();
      mesh.nor.push_back(static_cast<float>(n.X()));
      mesh.nor.push_back(static_cast<float>(n.Y()));
      mesh.nor.push_back(static_cast<float>(n.Z()));
    }
    const int first = static_cast<int>(mesh.idx.size() / 3);
    for (int i = 1; i <= tri->NbTriangles(); i++) {
      int a, b, c;
      tri->Triangle(i).Get(a, b, c);
      if (reversed) std::swap(b, c);
      mesh.idx.push_back(base + a - 1);
      mesh.idx.push_back(base + b - 1);
      mesh.idx.push_back(base + c - 1);
    }
    FaceRange fr{first, static_cast<int>(mesh.idx.size() / 3) - 1, colorOfShape(face)};
    mesh.faces.push_back(fr);
  }
  if (mesh.idx.empty()) return -1;
  gMeshes.push_back(std::move(mesh));
  return static_cast<int>(gMeshes.size()) - 1;
}

void processLabel(const TDF_Label& label, const TopLoc_Location& loc, const std::string& instanceName, Node& parent) {
  TDF_Label ref = label;
  if (XCAFDoc_ShapeTool::IsReference(label)) XCAFDoc_ShapeTool::GetReferredShape(label, ref);
  Node node;
  node.name = instanceName.empty() ? labelName(ref) : instanceName;
  if (!loc.IsIdentity()) {
    toMatrix(loc, node.matrix);
    node.hasMatrix = true;
  }
  if (XCAFDoc_ShapeTool::IsAssembly(ref)) {
    TDF_LabelSequence comps;
    XCAFDoc_ShapeTool::GetComponents(ref, comps, false);
    for (int i = 1; i <= comps.Length(); i++) {
      const TDF_Label& comp = comps.Value(i);
      TDF_Label compRef;
      XCAFDoc_ShapeTool::GetReferredShape(comp, compRef);
      std::string nm = labelName(compRef);
      if (nm.empty()) nm = labelName(comp);
      processLabel(comp, XCAFDoc_ShapeTool::GetLocation(comp), nm, node);
    }
  } else {
    const int key = ref.Tag() * 1000003 + ref.Father().Tag();
    auto it = gMeshOfLabel.find(key);
    int mi;
    if (it != gMeshOfLabel.end()) mi = it->second;
    else {
      TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(ref);
      shape.Location(TopLoc_Location());  // geometry in part coordinates
      mi = buildMesh(ref, shape, node.name);
      gMeshOfLabel[key] = mi;
    }
    if (mi >= 0) node.meshes.push_back(mi);
  }
  if (!node.meshes.empty() || !node.children.empty()) parent.children.push_back(std::move(node));
}

void writeColor(std::ostream& o, const Color& c) {
  if (!c.set) {
    o << "null";
    return;
  }
  o << "[" << c.r << "," << c.g << "," << c.b << "]";
}

void writeNode(std::ostream& o, const Node& n) {
  o << "{\"name\":\"" << jsonEscape(n.name) << "\",\"meshes\":[";
  for (size_t i = 0; i < n.meshes.size(); i++) o << (i ? "," : "") << n.meshes[i];
  o << "],\"children\":[";
  for (size_t i = 0; i < n.children.size(); i++) {
    if (i) o << ",";
    writeNode(o, n.children[i]);
  }
  o << "]";
  if (n.hasMatrix) {
    o << ",\"matrix\":[";
    for (int i = 0; i < 16; i++) o << (i ? "," : "") << n.matrix[i];
    o << "]";
  }
  o << "}";
}

}  // namespace

int run(const std::vector<std::string>& argv) {
  const size_t argc = argv.size();
  if (argc < 3) {
    std::cerr << "usage: cvimport <input.step|.iges|.brep> <output.cvmesh> [linearRatio] [angular]\n";
    return 2;
  }
  const std::string in = argv[1], out = argv[2];
  const double linRatio = argc > 3 ? std::atof(argv[3].c_str()) : 0.001;
  const double angular = argc > 4 ? std::atof(argv[4].c_str()) : 0.5;
  std::string ext = in.substr(in.find_last_of('.') + 1);
  std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
  const auto t0 = std::chrono::steady_clock::now();

  Handle(XCAFApp_Application) app = XCAFApp_Application::GetApplication();
  Handle(TDocStd_Document) doc;
  app->NewDocument("MDTV-XCAF", doc);
  Interface_Static::SetCVal("xstep.cascade.unit", "MM");

  try {
    if (ext == "step" || ext == "stp") {
      STEPCAFControl_Reader reader;
      reader.SetColorMode(true);
      reader.SetNameMode(true);
      reader.SetLayerMode(false);
      if (reader.ReadFile(in.c_str()) != IFSelect_RetDone) throw std::runtime_error("cannot read STEP file");
      if (!reader.Transfer(doc)) throw std::runtime_error("STEP transfer failed");
    } else if (ext == "iges" || ext == "igs") {
      IGESCAFControl_Reader reader;
      reader.SetColorMode(true);
      reader.SetNameMode(true);
      if (reader.ReadFile(in.c_str()) != IFSelect_RetDone) throw std::runtime_error("cannot read IGES file");
      if (!reader.Transfer(doc)) throw std::runtime_error("IGES transfer failed");
    } else if (ext == "brep" || ext == "brp") {
      TopoDS_Shape shape;
      BRep_Builder builder;
      if (!BRepTools::Read(shape, in.c_str(), builder)) throw std::runtime_error("cannot read BREP file");
      XCAFDoc_DocumentTool::ShapeTool(doc->Main())->AddShape(shape);
    } else {
      throw std::runtime_error("unsupported extension: " + ext);
    }
  } catch (const std::exception& e) {
    std::cerr << "error: " << e.what() << "\n";
    return 1;
  } catch (const Standard_Failure& e) {
    std::cerr << "error: " << e.GetMessageString() << "\n";
    return 1;
  }
  const auto t1 = std::chrono::steady_clock::now();

  gShapes = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  gColors = XCAFDoc_DocumentTool::ColorTool(doc->Main());
  TDF_LabelSequence roots;
  gShapes->GetFreeShapes(roots);

  // Mesh everything once; deflection relative to the overall size, like occt-import-js.
  TopoDS_Compound all;
  BRep_Builder bb;
  bb.MakeCompound(all);
  for (int i = 1; i <= roots.Length(); i++) bb.Add(all, XCAFDoc_ShapeTool::GetShape(roots.Value(i)));
  Bnd_Box box;
  BRepBndLib::Add(all, box);
  double deflection = 0.1;
  if (!box.IsVoid()) {
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    deflection = std::max(1e-4, ((x1 - x0) + (y1 - y0) + (z1 - z0)) / 3.0 * linRatio);
  }
  try {
    BRepMesh_IncrementalMesh mesher(all, deflection, false, angular, true);
  } catch (const Standard_Failure& e) {
    std::cerr << "mesh warning: " << e.GetMessageString() << "\n";
  }
  const auto t2 = std::chrono::steady_clock::now();

  Node root;
  root.name = "";
  for (int i = 1; i <= roots.Length(); i++) processLabel(roots.Value(i), XCAFDoc_ShapeTool::GetLocation(roots.Value(i)), "", root);

  // ---- write output ----
  std::ostringstream js;
  js.precision(9);
  uint64_t offset = 0;
  js << "{\"success\":true,\"root\":";
  writeNode(js, root);
  js << ",\"meshes\":[";
  for (size_t i = 0; i < gMeshes.size(); i++) {
    const Mesh& m = gMeshes[i];
    if (i) js << ",";
    js << "{\"name\":\"" << jsonEscape(m.name) << "\",\"color\":";
    writeColor(js, m.color);
    js << ",\"brep_faces\":[";
    for (size_t f = 0; f < m.faces.size(); f++) {
      if (f) js << ",";
      js << "{\"first\":" << m.faces[f].first << ",\"last\":" << m.faces[f].last << ",\"color\":";
      writeColor(js, m.faces[f].color);
      js << "}";
    }
    js << "],\"pos\":[" << offset << "," << m.pos.size() << "]";
    offset += m.pos.size() * 4;
    js << ",\"nor\":[" << offset << "," << m.nor.size() << "]";
    offset += m.nor.size() * 4;
    js << ",\"idx\":[" << offset << "," << m.idx.size() << "]}";
    offset += m.idx.size() * 4;
  }
  const double secRead = std::chrono::duration<double>(t1 - t0).count();
  const double secMesh = std::chrono::duration<double>(t2 - t1).count();
  js << "],\"timing\":{\"read\":" << secRead << ",\"mesh\":" << secMesh << "}}";
  const std::string json = js.str();

  std::ofstream f(std::filesystem::u8path(out), std::ios::binary);
  if (!f) {
    std::cerr << "error: cannot write " << out << "\n";
    return 1;
  }
  f.write("CVMESH01", 8);
  const uint32_t jl = static_cast<uint32_t>(json.size());
  f.write(reinterpret_cast<const char*>(&jl), 4);
  f.write(json.data(), json.size());
  const size_t pad = (4 - ((12 + json.size()) % 4)) % 4;
  static const char zeros[4] = {0, 0, 0, 0};
  f.write(zeros, pad);
  for (const Mesh& m : gMeshes) {
    f.write(reinterpret_cast<const char*>(m.pos.data()), m.pos.size() * 4);
    f.write(reinterpret_cast<const char*>(m.nor.data()), m.nor.size() * 4);
    f.write(reinterpret_cast<const char*>(m.idx.data()), m.idx.size() * 4);
  }
  if (!f) {
    std::cerr << "error: write failed\n";
    return 1;
  }
  return 0;
}

// File names are passed to OpenCascade as UTF-8; on Windows read the wide
// command line so paths with non-ASCII characters (e.g. Vietnamese) work.
#ifdef _WIN32
#include <windows.h>
int wmain(int argc, wchar_t** wargv) {
  std::vector<std::string> args;
  for (int i = 0; i < argc; i++) {
    const int n = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, nullptr, 0, nullptr, nullptr);
    std::string a(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, &a[0], n, nullptr, nullptr);
    args.push_back(a);
  }
  return run(args);
}
#else
int main(int argc, char** argv) { return run(std::vector<std::string>(argv, argv + argc)); }
#endif
