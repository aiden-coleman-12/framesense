figma.showUI(__html__, { width: 700, height: 700 });

// ── Violation node reference (id + name) sent to the UI ──
type NodeRef = { id: string; name: string };

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
  // Zach's additions
  accessibilityViolations: number;
  accessibilityDetails: string[];
  // Aiden's additions
  totalStyles: number;
  // ── Violation node lists (new) ──
  accessibilityNodes: NodeRef[];
  unlinkedStyleNodes: NodeRef[];
  offGridNodes: NodeRef[];
  numberedNameNodes: NodeRef[];
  noAutoLayoutNodes: NodeRef[];
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
    figma.ui.postMessage({ type: "result", data: result });
  }

  // ── Select a node by id when the user clicks a violation row ──
  if (msg.type === "select-node") {
  figma.getNodeByIdAsync(msg.id).then((node) => {
    if (node && "type" in node) {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
  });
}
};

// Spacing grid constant (8pt system)
const SPACING_GRID = 8;

function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(lum1: number, lum2: number): number {
  const lighter = Math.max(lum1, lum2);
  const darker  = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function analyzeNode(root: SceneNode): AnalysisResult {
  let totalNodes = 0;
  let maxDepth   = 0;

  // Existing counters
  let totalFrameLike   = 0;
  let componentCount   = 0;
  let autoLayoutCount  = 0;
  let numberedNameCount = 0;

  // Dan's counters
  let effectCount        = 0;
  let groupCount         = 0;
  let unusualSpacingCount = 0;
  const unusualSpacingSet = new Set<number>();
  const typefaceSet       = new Set<string>();

  // Zach's counters
  let accessibilityViolations = 0;
  const accessibilityDetails: string[] = [];

  // Aiden's counter
  let totalStyles = 0;

  // ── Violation node lists ──
  const accessibilityNodes: NodeRef[] = [];
  const unlinkedStyleNodes: NodeRef[] = [];
  const offGridNodes:        NodeRef[] = [];
  const numberedNameNodes:   NodeRef[] = [];
  const noAutoLayoutNodes:   NodeRef[] = [];

  // Helper: push a NodeRef only if this node isn't already in the list
  function addRef(list: NodeRef[], node: SceneNode) {
    if (!list.find(r => r.id === node.id)) {
      list.push({ id: node.id, name: node.name });
    }
  }

  function traverse(node: SceneNode, depth: number) {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // ------- Existing logic -------

    if (/\d/.test(node.name)) {
      numberedNameCount++;
      addRef(numberedNameNodes, node);
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

      if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
        autoLayoutCount++;
      } else if (node.type === "FRAME") {
        // Plain frame with no auto-layout
        addRef(noAutoLayoutNodes, node);
      }
    }

    // ------- Dan: 1. Effect count -------
    if ("effects" in node && node.effects.length > 0) {
      effectCount += node.effects.length;
    }

    // ------- Dan: 2. Group count -------
    if (node.type === "GROUP") {
      groupCount++;
    }

    // ------- Dan: 4. Unusual spacing values -------
    if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
      const f = node as FrameNode;
      const spacingValues = [
        f.paddingLeft,
        f.paddingRight,
        f.paddingTop,
        f.paddingBottom,
        f.itemSpacing,
      ];

      let nodeHasOffGrid = false;
      for (const val of spacingValues) {
        if (val > 0 && val % SPACING_GRID !== 0) {
          unusualSpacingCount++;
          unusualSpacingSet.add(val);
          nodeHasOffGrid = true;
        }
      }
      if (nodeHasOffGrid) addRef(offGridNodes, node);
    }

    // ------- Dan: 5. Typefaces used -------
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      if (typeof textNode.fontName !== "symbol") {
        typefaceSet.add(textNode.fontName.family);
      } else {
        const len = textNode.characters.length;
        for (let i = 0; i < len; i++) {
          const fn = textNode.getRangeFontName(i, i + 1);
          if (typeof fn !== "symbol") {
            typefaceSet.add((fn as FontName).family);
          }
        }
      }
    }

    // ------- Zach: 6. Accessibility violations -------

    // 6a. Touch target size
    const isTappable =
      node.type === "INSTANCE" ||
      node.type === "COMPONENT" ||
      (node.type === "FRAME" && "layoutMode" in node);

    if (isTappable && "width" in node && "height" in node) {
      if (node.width < 44 || node.height < 44) {
        accessibilityViolations++;
        accessibilityDetails.push(
          `Touch target too small: "${node.name}" (${Math.round(node.width)}×${Math.round(node.height)}px)`
        );
        addRef(accessibilityNodes, node);
      }
    }

    // 6b. Text contrast
    if (node.type === "TEXT" && "fills" in node) {
      const fills = node.fills;
      if (Array.isArray(fills)) {
        for (const fill of fills) {
          if (fill.type === "SOLID" && fill.visible !== false) {
            const { r, g, b } = fill.color;
            const opacity  = fill.opacity ?? 1;
            const blendedR = r * opacity + (1 - opacity);
            const blendedG = g * opacity + (1 - opacity);
            const blendedB = b * opacity + (1 - opacity);
            const textLum  = relativeLuminance(blendedR, blendedG, blendedB);
            const bgLum    = 1;
            const ratio    = contrastRatio(textLum, bgLum);
            const textNode = node as TextNode;
            const fontSize = typeof textNode.fontSize === "number" ? textNode.fontSize : 16;
            const isLargeText = fontSize >= 18 || fontSize >= 14;
            const threshold = isLargeText ? 3 : 4.5;

            if (ratio < threshold) {
              accessibilityViolations++;
              accessibilityDetails.push(
                `Low contrast: "${node.name}" ratio ${ratio.toFixed(2)}:1 (needs ${threshold}:1)`
              );
              addRef(accessibilityNodes, node);
            }
          }
        }
      }
    }

    // ------- Aiden: 7. Unlinked styles -------
    let styleViolations = 0;

    // Fill style
    if ("fills" in node && "fillStyleId" in node) {
      const fills = node.fills as ReadonlyArray<Paint>;
      const hasActiveFill =
        Array.isArray(fills) && fills.some((f) => f.visible !== false);
      if (hasActiveFill) {
        const id = (node as GeometryMixin).fillStyleId;
        if (typeof id === "string" && id === "") {
          styleViolations++;
        }
      }
    }

    // Effect style
    if ("effects" in node && "effectStyleId" in node) {
      const effects = node.effects as ReadonlyArray<Effect>;
      const hasActiveEffect =
        Array.isArray(effects) && effects.some((e) => e.visible !== false);
      if (hasActiveEffect) {
        const id = (node as BlendMixin).effectStyleId;
        if (typeof id === "string" && id === "") {
          styleViolations++;
        }
      }
    }

    // Text style
    if (node.type === "TEXT") {
      const id = (node as TextNode).textStyleId;
      if (typeof id === "string" && id === "") {
        styleViolations++;
      }
    }

    if (styleViolations > 0) {
      totalStyles += styleViolations;
      addRef(unlinkedStyleNodes, node);
    }

    // ------- Recurse into children -------
    if ("children" in node) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }

  traverse(root, 0);

  const componentProportion  = totalFrameLike > 0 ? componentCount  / totalFrameLike : 0;
  const autoLayoutProportion = totalFrameLike > 0 ? autoLayoutCount / totalFrameLike : 0;

  return {
    totalNodes,
    maxDepth,
    componentProportion,
    autoLayoutProportion,
    numberedNameCount,
    effectCount,
    groupCount,
    unusualSpacingCount,
    unusualSpacingValues: Array.from(unusualSpacingSet).sort((a, b) => a - b),
    typefaceCount: typefaceSet.size,
    typefaceNames: Array.from(typefaceSet).sort(),
    accessibilityViolations,
    accessibilityDetails,
    totalStyles,
    // Violation node lists
    accessibilityNodes,
    unlinkedStyleNodes,
    offGridNodes,
    numberedNameNodes,
    noAutoLayoutNodes,
  };
}