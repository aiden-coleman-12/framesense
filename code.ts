figma.showUI(__html__, { width: 700, height: 700 });

// ── Shared types ─────────────────────────────────────────────────────────────

type NodeRef = { id: string; name: string; details?: string };
type FlowRef  = { nodeId: string; name: string };

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

    const root = selection[0];

    if (!("children" in root)) {
      figma.ui.postMessage({
        type: "error",
        message: "No connected frames found in this flow.",
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

  function traverse(node: BaseNode, depth: number): void {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // ------- Existing logic -------

    if (/\d/.test(node.name)) {
      numberedNameCount++;
      addRef(numberedNameNodes, node);
    }

    // ── Frame-like nodes: components & auto-layout ──
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
        addRef(noAutoLayoutNodes, node);
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
          badProps.push(`${label}: ${val}`);
        }
      }
      if (badProps.length > 0) {
        addRef(offGridNodes, node, badProps.join("  ·  "));
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

    // ── Accessibility: touch target size ──
    const isTappable =
      node.type === "INSTANCE" ||
      node.type === "COMPONENT" ||
      (node.type === "FRAME" && "layoutMode" in node);

    if (isTappable && "width" in node && "height" in node) {
      if (node.width < 44 || node.height < 44) {
        accessibilityViolations++;
        accessibilityDetails.push(
          `Touch target too small: "${node.name}" (${Math.round(
            node.width
          )}×${Math.round(node.height)}px)`
        );
        addRef(accessibilityNodes, node);
      }
    }

    // ── Accessibility: text contrast ──
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
            const ratio    = contrastRatio(textLum, 1);
            const textNode = node as TextNode;
            const fontSize =
              typeof textNode.fontSize === "number" ? textNode.fontSize : 16;
            const isLargeText = fontSize >= 18 || fontSize >= 14;
            const threshold   = isLargeText ? 3 : 4.5;

            if (ratio < threshold) {
              accessibilityViolations++;
              accessibilityDetails.push(
                `Low contrast: "${node.name}" ratio ${ratio.toFixed(
                  2
                )}:1 (needs ${threshold}:1)`
              );
              addRef(accessibilityNodes, node);
            }
          }
        }
      }
    }

    // ── Unlinked styles ──
    let styleViolations = 0;

    if ("fills" in node && "fillStyleId" in node) {
      const fills = node.fills as ReadonlyArray<Paint>;
      const hasActiveFill =
        Array.isArray(fills) && fills.some((f) => f.visible !== false);
      const hasImageOrGradient =
        Array.isArray(fills) &&
        fills.some(
          (f) =>
            f.type === "IMAGE" ||
            f.type === "GRADIENT_LINEAR" ||
            f.type === "GRADIENT_RADIAL" ||
            f.type === "GRADIENT_ANGULAR" ||
            f.type === "GRADIENT_DIAMOND"
        );

      if (hasActiveFill && !hasImageOrGradient) {
        const id = (node as GeometryMixin).fillStyleId;
        if (typeof id === "string" && id === "") styleViolations++;
      }
    }

    if ("effects" in node && "effectStyleId" in node) {
      const effects = node.effects as ReadonlyArray<Effect>;
      const hasActiveEffect =
        Array.isArray(effects) && effects.some((e) => e.visible !== false);
      if (hasActiveEffect) {
        const id = (node as BlendMixin).effectStyleId;
        if (typeof id === "string" && id === "") styleViolations++;
      }
    }

    if (node.type === "TEXT") {
      const id = (node as TextNode).textStyleId;
      if (typeof id === "string" && id === "") styleViolations++;
    }

    if (styleViolations > 0) {
      totalStyles += styleViolations;
      addRef(unlinkedStyleNodes, node);
    }

    // ── Recurse ──
    if ("children" in node) {
      for (const child of (node as ChildrenMixin).children) {
        traverse(child, depth + 1);
      }
    }
  }

  traverse(root, 0);

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
    accessibilityNodes,
    unlinkedStyleNodes,
    offGridNodes,
    numberedNameNodes,
    noAutoLayoutNodes,
  };
}