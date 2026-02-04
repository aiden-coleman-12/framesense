figma.showUI(__html__, { width: 400, height: 400 });

type ComplexityResult = {
  totalNodes: number;
  maxDepth: number;
  score: number;
};

figma.ui.onmessage = (msg) => {
  if (msg.type === "analyze-selection") {
    const selection = figma.currentPage.selection;

    if (selection.length !== 1) {
      figma.ui.postMessage({
        type: "error",
        message: "Please select exactly one frame or group.",
      });
      return;
    }

    const root = selection[0];

    if (!("children" in root)) {
      figma.ui.postMessage({
        type: "error",
        message: "Selected node has no children.",
      });
      return;
    }

    const result = analyzeNode(root);

    figma.ui.postMessage({
      type: "result",
      data: result,
    });
  }
};

function analyzeNode(root: SceneNode): ComplexityResult {
  let totalNodes = 0;
  let maxDepth = 0;
  let score = 0;

  function traverse(node: SceneNode, depth: number) {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // Base score per node
    score += 1;

    // Complexity weighting by type
    switch (node.type) {
      case "TEXT":
        score += 2;
        break;
      case "VECTOR":
      case "BOOLEAN_OPERATION":
        score += 3;
        break;
      case "COMPONENT":
      case "COMPONENT_SET":
        score += 4;
        break;
      case "INSTANCE":
        score += 2;
        break;
      case "FRAME":
      case "GROUP":
        score += 1;
        break;
    }

    // Depth penalty (indentation complexity)
    score += depth * 0.5;

    if ("children" in node) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }

  traverse(root, 0);

  return {
    totalNodes,
    maxDepth,
    score: Math.round(score),
  };
}
