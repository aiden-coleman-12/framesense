figma.showUI(__html__, { width: 400, height: 500 });

type AnalysisResult = {
  totalNodes: number;
  maxDepth: number;
  componentProportion: number;   // 0–1, fraction of frames that are components/instances
  autoLayoutProportion: number;  // 0–1, fraction of frames using auto-layout
  numberedNameCount: number;     // frames whose name contains a digit
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

function analyzeNode(root: SceneNode): AnalysisResult {
  let totalNodes = 0;
  let maxDepth = 0;

  // Frame-level counters
  let totalFrameLike = 0;       // FRAME, COMPONENT, COMPONENT_SET, INSTANCE
  let componentCount = 0;       // COMPONENT, COMPONENT_SET, INSTANCE
  let autoLayoutCount = 0;      // frames with layoutMode !== 'NONE'
  let numberedNameCount = 0;    // any node whose name contains a digit

  function traverse(node: SceneNode, depth: number) {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // Count nodes whose name contains a number
    if (/\d/.test(node.name)) {
      numberedNameCount++;
    }

    // Frame-like nodes
    const isFrameLike =
      node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET" ||
      node.type === "INSTANCE";

    if (isFrameLike) {
      totalFrameLike++;

      // Components / instances
      if (
        node.type === "COMPONENT" ||
        node.type === "COMPONENT_SET" ||
        node.type === "INSTANCE"
      ) {
        componentCount++;
      }

      // Auto-layout: layoutMode is 'HORIZONTAL' or 'VERTICAL'
      if (
        "layoutMode" in node &&
        (node as FrameNode).layoutMode !== "NONE"
      ) {
        autoLayoutCount++;
      }
    }

    if ("children" in node) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }

  traverse(root, 0);

  const componentProportion =
    totalFrameLike > 0 ? componentCount / totalFrameLike : 0;
  const autoLayoutProportion =
    totalFrameLike > 0 ? autoLayoutCount / totalFrameLike : 0;

  return {
    totalNodes,
    maxDepth,
    componentProportion,
    autoLayoutProportion,
    numberedNameCount,
  };
}
