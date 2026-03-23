figma.showUI(__html__, { width: 700, height: 700 });

type AnalysisResult = {
  // Existing
  totalNodes: number;
  maxDepth: number;
  componentProportion: number;
  autoLayoutProportion: number;
  numberedNameCount: number;
  // Dan's additions
  effectCount: number;
  groupCount: number;
  unusualSpacingCount: number;
  unusualSpacingValues: number[];
  typefaceCount: number;
  typefaceNames: string[];
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

if (msg.type === 'resize') {
  figma.ui.resize(msg.width, msg.height);
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
    figma.ui.postMessage({ type: "result", data: result });
  }
};

// The spacing grid to validate against (8pt is standard; adjust to your design system)
const SPACING_GRID = 8;

function analyzeNode(root: SceneNode): AnalysisResult {
  let totalNodes = 0;
  let maxDepth = 0;

  // Existing counters
  let totalFrameLike = 0;
  let componentCount = 0;
  let autoLayoutCount = 0;
  let numberedNameCount = 0;

  // Dan's counters
  let effectCount = 0;
  let groupCount = 0;
  let unusualSpacingCount = 0;
  const unusualSpacingSet = new Set<number>(); // unique off-grid values seen
  const typefaceSet = new Set<string>();

  function traverse(node: SceneNode, depth: number) {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // ------- Existing logic -------

    if (/\d/.test(node.name)) {
      numberedNameCount++;
    }

    const isFrameLike =
      node.type === "FRAME" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET" ||
      node.type === "INSTANCE";

    if (isFrameLike) {
      totalFrameLike++;

      if (
        node.type === "COMPONENT" ||
        node.type === "COMPONENT_SET" ||
        node.type === "INSTANCE"
      ) {
        componentCount++;
      }

      if (
        "layoutMode" in node &&
        (node as FrameNode).layoutMode !== "NONE"
      ) {
        autoLayoutCount++;
      }
    }

    // ------- Dan: 1. Effect count -------
    // Counts every shadow, blur, etc. applied to any node.
    if ("effects" in node && node.effects.length > 0) {
      effectCount += node.effects.length;
    }

    // ------- Dan: 2. Group count -------
    // Groups are explicitly typed. Flags poor structure vs. frames.
    if (node.type === "GROUP") {
      groupCount++;
    }

    // ------- Dan: 3. Detached instances (heuristic) -------
    // Figma has no native "isDetached" flag — once detached, an instance
    // becomes a plain FRAME and loses its mainComponent link.
    // Heuristic: non-root FRAMEs with a PascalCase name are likely
    // detached instances (designers typically PascalCase component names).

    // ------- Dan: 4. Unusual spacing values -------
    // Checks all auto-layout padding + gap values against the 8pt grid.
    if (
      "layoutMode" in node &&
      (node as FrameNode).layoutMode !== "NONE"
    ) {
      const f = node as FrameNode;
      const spacingValues = [
        f.paddingLeft,
        f.paddingRight,
        f.paddingTop,
        f.paddingBottom,
        f.itemSpacing,
      ];

      for (const val of spacingValues) {
        if (val > 0 && val % SPACING_GRID !== 0) {
          unusualSpacingCount++;
          unusualSpacingSet.add(val);
        }
      }
    }

    // ------- Dan: 5. Typefaces used -------
    // Collects unique font families. Handles mixed-style text nodes where
    // different runs may use different fonts (fontName returns a Symbol).
    if (node.type === "TEXT") {
      const textNode = node as TextNode;

      if (typeof textNode.fontName !== "symbol") {
        // Single consistent font across the whole text node
        typefaceSet.add(textNode.fontName.family);
      } else {
        // Mixed fonts — walk each character and collect unique families
        const len = textNode.characters.length;
        for (let i = 0; i < len; i++) {
          const fn = textNode.getRangeFontName(i, i + 1);
          if (typeof fn !== "symbol") {
            typefaceSet.add((fn as FontName).family);
          }
        }
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
    // Dan's results
    effectCount,
    groupCount,
    unusualSpacingCount,
    unusualSpacingValues: Array.from(unusualSpacingSet).sort((a, b) => a - b),
    typefaceCount: typefaceSet.size,
    typefaceNames: Array.from(typefaceSet).sort(),
  };
}