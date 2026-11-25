cmake_minimum_required(VERSION 3.20)
project(bubblegun_wasm LANGUAGES CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Build this with emcmake (see build.sh)")
endif()

# Only the detection library: no CLI (argparse) and no GFA file reader (zlib).
set(BUBBLEGUN_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(BUBBLEGUN_WITH_GFA_READER OFF CACHE BOOL "" FORCE)
add_subdirectory(bubblegun2)

add_executable(bubblegun-wasm bindings.cpp)
target_link_libraries(bubblegun-wasm PRIVATE bubblegun)
target_compile_options(bubblegun-wasm PRIVATE -O3)
target_link_options(bubblegun-wasm PRIVATE
    -O3
    "-sWASM=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createBubbleGunModule"
    "-sENVIRONMENT=web,worker"
    --bind
)

# Produces bubblegun.js and bubblegun.wasm; build.sh copies them into js/.
set_target_properties(bubblegun-wasm PROPERTIES
    OUTPUT_NAME bubblegun
    SUFFIX ".js"
)
