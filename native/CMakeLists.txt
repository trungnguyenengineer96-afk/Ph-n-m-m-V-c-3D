cmake_minimum_required(VERSION 3.16)
project(cvimport CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(OpenCASCADE CONFIG REQUIRED)

add_executable(cvimport cvimport.cpp)
target_include_directories(cvimport PRIVATE ${OpenCASCADE_INCLUDE_DIR})
# Only the toolkits the importer needs. Data-exchange toolkits were renamed in
# OCCT 7.8 (TKXDESTEP -> TKDESTEP ...), so take whichever names exist.
set(CVIMPORT_TOOLKITS
  TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKPrim
  TKShHealing TKMesh TKBO TKBool TKService TKV3d TKCDF TKLCAF TKCAF TKVCAF
  TKXCAF TKXSBase TKSTEPBase TKSTEPAttr TKSTEP209 TKSTEP TKIGES TKXDESTEP
  TKXDEIGES TKDE TKDESTEP TKDEIGES)
set(CVIMPORT_LIBS "")
foreach(tk ${CVIMPORT_TOOLKITS})
  if(TARGET ${tk})
    list(APPEND CVIMPORT_LIBS ${tk})
  endif()
endforeach()
message(STATUS "cvimport links: ${CVIMPORT_LIBS}")
target_link_libraries(cvimport PRIVATE ${CVIMPORT_LIBS})
if(MSVC)
  target_compile_options(cvimport PRIVATE /utf-8 /EHsc)
  target_compile_definitions(cvimport PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# `cmake --install` copies the executable plus the non-system DLLs it needs.
install(TARGETS cvimport RUNTIME DESTINATION .)
if(WIN32)
  # Directories searched for the OpenCascade DLLs and their dependencies.
  if(NOT CVIMPORT_DLL_DIRS)
    set(CVIMPORT_DLL_DIRS "${OpenCASCADE_BINARY_DIR}" "${OpenCASCADE_INSTALL_PREFIX}/bin")
  endif()
  install(CODE "set(CVIMPORT_DLL_DIRS \"${CVIMPORT_DLL_DIRS}\")")
  # The MSVC runtime, so users need no Visual C++ redistributable.
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
  set(CMAKE_INSTALL_UCRT_LIBRARIES FALSE)
  include(InstallRequiredSystemLibraries)
  install(CODE [[
    file(GET_RUNTIME_DEPENDENCIES
      EXECUTABLES "$<TARGET_FILE:cvimport>"
      RESOLVED_DEPENDENCIES_VAR deps
      UNRESOLVED_DEPENDENCIES_VAR missing
      DIRECTORIES "${CVIMPORT_DLL_DIRS}"
      PRE_EXCLUDE_REGEXES "api-ms-.*" "ext-ms-.*"
      POST_EXCLUDE_REGEXES ".*[Ss]ystem32/.*\\.dll" ".*[Ww]indows/.*")
    foreach(d ${deps})
      file(INSTALL "${d}" DESTINATION "${CMAKE_INSTALL_PREFIX}")
    endforeach()
    if(missing)
      message(STATUS "Unresolved (assumed system): ${missing}")
    endif()
  ]])
endif()
