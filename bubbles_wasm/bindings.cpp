// Emscripten bindings for BubbleGun2 bubble detection

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <string>
#include <vector>

#include "bubblegun.h"

using namespace emscripten;
using bubblegun::graph::PackedGraph;

// A typed_memory_view points into WASM memory, which later allocations can
// move, so the returned arrays are copies owned by JS.
template <typename T>
static val toTypedArray(const std::vector<T>& values) {
    return val(typed_memory_view(values.size(), values.data())).call<val>("slice");
}

static val errorResult(const std::string& message) {
    val result = val::object();
    result.set("error", message);
    return result;
}

// nodeLengths: one length per segment, nodes referred to by their position.
// edges: four numbers per GFA L line: from index, 1 if from is '-', to index,
// 1 if to is '-'. Returns the bubbles as parallel typed arrays (type: 0
// simple, 1 super, 2 insertion; parent: -1 at the top level), with bubble i's
// inside nodes at inside[insideOffsets[i] .. insideOffsets[i + 1]).
static val findBubbles(const val& jsNodeLengths, const val& jsEdges) {
    std::vector<std::uint32_t> lengths = convertJSArrayToNumberVector<std::uint32_t>(jsNodeLengths);
    const std::vector<std::uint32_t> flatEdges = convertJSArrayToNumberVector<std::uint32_t>(jsEdges);
    if (flatEdges.size() % 4 != 0) {
        return errorResult("edges must have four numbers per edge");
    }

    std::vector<PackedGraph::Edge> edges;
    edges.reserve(flatEdges.size() / 4);
    for (std::size_t i = 0; i < flatEdges.size(); i += 4) {
        if (flatEdges[i] >= lengths.size() || flatEdges[i + 2] >= lengths.size()) {
            return errorResult("an edge refers to a node index past the last node");
        }
        edges.push_back({flatEdges[i], flatEdges[i + 1] != 0, flatEdges[i + 2], flatEdges[i + 3] != 0, 0});
    }

    // Node names stay on the JS side, so the ids here are left empty.
    const std::size_t nodeCount = lengths.size();
    PackedGraph graph = PackedGraph::from_edges(std::vector<std::string>(nodeCount), std::move(lengths), edges);
    const auto bubbles = bubblegun::bubbles::find_bubbles(graph);

    std::vector<std::uint32_t> source, sink, insideOffsets, inside;
    std::vector<std::uint8_t> type;
    std::vector<std::int32_t> parent;
    insideOffsets.push_back(0);
    for (const auto& bubble : bubbles) {
        source.push_back(bubble.source);
        sink.push_back(bubble.sink);
        type.push_back(static_cast<std::uint8_t>(bubble.type));
        parent.push_back(bubble.parent == bubblegun::bubbles::no_parent ? -1 : static_cast<std::int32_t>(bubble.parent));
        inside.insert(inside.end(), bubble.inside.begin(), bubble.inside.end());
        insideOffsets.push_back(static_cast<std::uint32_t>(inside.size()));
    }

    val result = val::object();
    result.set("source", toTypedArray(source));
    result.set("sink", toTypedArray(sink));
    result.set("type", toTypedArray(type));
    result.set("parent", toTypedArray(parent));
    result.set("insideOffsets", toTypedArray(insideOffsets));
    result.set("inside", toTypedArray(inside));
    return result;
}

EMSCRIPTEN_BINDINGS(bubblegun) {
    function("findBubbles", &findBubbles);
}
