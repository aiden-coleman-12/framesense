figma.showUI(__html__, { width: 700, height: 700 });

// ── Shared types ─────────────────────────────────────────────────────────────

type NodeRef = { id: string; name: string; details?: string };
type FlowRef  = { nodeId: string; name: string };

type AnalysisResult = {
  // Structure
  totalNodes: number;
  maxDepth: number;
  componentProportion: number;
  autoLayoutProportion: number;
  numberedNameCount: number;
  // Complexity
  effectCount: number;
  groupCount: number;
  unusualSpacingCount: number;
  unusualSpacingValues: number[];
  typefaceCount: number;
  typefaceNames: string[];
  // Accessibility
  accessibilityViolations: number;
  accessibilityDetails: string[];
  // Design tokens
  totalStyles: number;
  // Violation node lists
  accessibilityNodes: NodeRef[];
  unlinkedStyleNodes: NodeRef[];
  offGridNodes: NodeRef[];
  numberedNameNodes: NodeRef[];
  noAutoLayoutNodes: NodeRef[];
};

// ── Flow-traversal helpers ───────────────────────────────────────────────────

function isContainerNode(node: BaseNode | null): node is BaseNode & ChildrenMixin {
  return !!node && "children" in node;
}

function isFrameLikeNode(node: BaseNode | null): node is SceneNode & ChildrenMixin {
  return (
    !!node &&
    (node.type === "FRAME" ||
      node.type === "GROUP" ||
      node.type === "SECTION" ||
      node.type === "COMPONENT" ||
      node.type === "COMPONENT_SET" ||
      node.type === "INSTANCE")
  );
}

function getContainingScreen(
  node: BaseNode | null
): (SceneNode & ChildrenMixin) | null {
  let current: BaseNode | null = node;
  while (current) {
    if (isFrameLikeNode(current)) return current;
    current = current.parent;
  }
  return null;
}

async function collectReactionDestinationsDeep(
  node: BaseNode
): Promise<string[]> {
  const destinationIds = new Set<string>();

  async function walk(current: BaseNode): Promise<void> {
    if ("reactions" in current) {
      const reactions = (current as SceneNode & { reactions: Reaction[] })
        .reactions;
      for (const reaction of reactions) {
        const action = reaction.action as {
          type?: string;
          destinationId?: string;
        } | null;
        if (action && action.type === "NODE" && action.destinationId) {
          destinationIds.add(action.destinationId);
        }
      }
    }
    if ("children" in current) {
      for (const child of (current as ChildrenMixin).children) {
        await walk(child);
      }
    }
  }

  await walk(node);
  return Array.from(destinationIds);
}

async function getConnectedFlowNodes(
  startNode: BaseNode
): Promise<(BaseNode & ChildrenMixin)[]> {
  const startScreen = getContainingScreen(startNode);
  if (!startScreen) return [];

  const visitedScreenIds = new Set<string>();
  const queuedScreenIds  = new Set<string>([startScreen.id]);
  const queue: (SceneNode & ChildrenMixin)[] = [startScreen];
  const results: (BaseNode & ChildrenMixin)[] = [];

  while (queue.length > 0) {
    const screen = queue.shift()!;
    queuedScreenIds.delete(screen.id);

    if (visitedScreenIds.has(screen.id)) continue;
    visitedScreenIds.add(screen.id);
    results.push(screen);

    const destinationIds = await collectReactionDestinationsDeep(screen);
    for (const destId of destinationIds) {
      const destNode   = await figma.getNodeByIdAsync(destId);
      const destScreen = getContainingScreen(destNode);
      if (
        destScreen &&
        !visitedScreenIds.has(destScreen.id) &&
        !queuedScreenIds.has(destScreen.id)
      ) {
        queue.push(destScreen);
        queuedScreenIds.add(destScreen.id);
      }
    }
  }

  return results;
}

async function getFlowsForNode(node: BaseNode): Promise<FlowRef[]> {
  const allFlows = figma.currentPage.flowStartingPoints;
  if (allFlows.length === 0) return [];

  const matchingFlows: FlowRef[] = [];

  const ancestorIds = new Set<string>();
  let current: BaseNode | null = node;
  while (current) {
    ancestorIds.add(current.id);
    current = current.parent;
  }

  for (const flow of allFlows) {
    if (ancestorIds.has(flow.nodeId)) {
      matchingFlows.push({ nodeId: flow.nodeId, name: flow.name });
      continue;
    }
    const startNode = await figma.getNodeByIdAsync(flow.nodeId);
    if (!startNode) continue;

    const connectedNodes = await getConnectedFlowNodes(startNode);
    if (connectedNodes.some((n) => ancestorIds.has(n.id))) {
      matchingFlows.push({ nodeId: flow.nodeId, name: flow.name });
    }
  }

  return matchingFlows;
}

async function sendFlowsForSelection(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 1) {
    const flows = await getFlowsForNode(selection[0]);
    figma.ui.postMessage({ type: "flows-list", flows });
  } else {
    figma.ui.postMessage({ type: "flows-list", flows: [] });
  }
}

// Update flow dropdown whenever the user changes their Figma selection
figma.on("selectionchange", () => {
  sendFlowsForSelection();
});

// ── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: {
  type: string;
  nodeId?: string;
  id?: string;
}) => {
  // ── ui-ready: populate flow dropdown on first open ──
  if (msg.type === "ui-ready") {
    await sendFlowsForSelection();
    return;
  }

  // ── analyze-selection: single-frame mode ──
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
        message: "Selected node has no children. Please select a frame, group, or section.",
      });
      return;
    }

    figma.ui.postMessage({
      type: "result",
      data: analyzeNode(root),
      mode: "frame",
      frameCount: 1,
    });
    return;
  }

  // ── analyze-flow: entire prototype flow mode ──
  if (msg.type === "analyze-flow") {
    if (!msg.nodeId) {
      figma.ui.postMessage({
        type: "error",
        message: "No flow node ID provided.",
      });
      return;
    }

    const startNode = await figma.getNodeByIdAsync(msg.nodeId);
    if (!startNode) {
      figma.ui.postMessage({
        type: "error",
        message: "Flow starting frame not found.",
      });
      return;
    }

    const flowNodes = await getConnectedFlowNodes(startNode);
    if (flowNodes.length === 0) {
      figma.ui.postMessage({
        type: "error",
        message: "No connected frames found in this flow.",
      });
      return;
    }

    figma.ui.postMessage({
      type: "result",
      data: mergeResults(flowNodes.map((n) => analyzeNode(n as SceneNode))),
      mode: "flow",
      frameCount: flowNodes.length,
    });
    return;
  }

  // ── select-node: click violation row → scroll to node in Figma ──
  if (msg.type === "select-node") {
    figma.getNodeByIdAsync(msg.id!).then((node) => {
      if (node && "type" in node) {
        figma.currentPage.selection = [node as SceneNode];
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      }
    });
  }
};

// ── Merge helpers (used by flow mode) ───────────────────────────────────────

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function mergeRefs(target: NodeRef[], source: NodeRef[]): void {
  for (const ref of source) {
    if (!target.find((n) => n.id === ref.id)) target.push(ref);
  }
}

function mergeResults(results: AnalysisResult[]): AnalysisResult {
  const allTypefaces   = new Set<string>();
  const allSpacingVals = new Set<number>();

  let totalNodes          = 0;
  let maxDepth            = 0;
  let numberedNameCount   = 0;
  let effectCount         = 0;
  let groupCount          = 0;
  let unusualSpacingCount = 0;
  let accessibilityViolations = 0;
  const accessibilityDetails: string[] = [];
  let totalStyles = 0;

  const accessibilityNodes: NodeRef[] = [];
  const unlinkedStyleNodes: NodeRef[] = [];
  const offGridNodes:        NodeRef[] = [];
  const numberedNameNodes:   NodeRef[] = [];
  const noAutoLayoutNodes:   NodeRef[] = [];

  for (const r of results) {
    totalNodes          += r.totalNodes;
    maxDepth             = Math.max(maxDepth, r.maxDepth);
    numberedNameCount   += r.numberedNameCount;
    effectCount         += r.effectCount;
    groupCount          += r.groupCount;
    unusualSpacingCount += r.unusualSpacingCount;
    accessibilityViolations += r.accessibilityViolations;
    accessibilityDetails.push(...r.accessibilityDetails);
    totalStyles += r.totalStyles;

    r.typefaceNames.forEach((t) => allTypefaces.add(t));
    r.unusualSpacingValues.forEach((v) => allSpacingVals.add(v));

    mergeRefs(accessibilityNodes, r.accessibilityNodes);
    mergeRefs(unlinkedStyleNodes, r.unlinkedStyleNodes);
    mergeRefs(offGridNodes,        r.offGridNodes);
    mergeRefs(numberedNameNodes,   r.numberedNameNodes);
    mergeRefs(noAutoLayoutNodes,   r.noAutoLayoutNodes);
  }

  return {
    totalNodes,
    maxDepth,
    componentProportion:  avg(results.map((r) => r.componentProportion)),
    autoLayoutProportion: avg(results.map((r) => r.autoLayoutProportion)),
    numberedNameCount,
    effectCount,
    groupCount,
    unusualSpacingCount,
    unusualSpacingValues: Array.from(allSpacingVals).sort((a, b) => a - b),
    typefaceCount: allTypefaces.size,
    typefaceNames: Array.from(allTypefaces).sort(),
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

// ── Analysis ─────────────────────────────────────────────────────────────────

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
  let totalNodes    = 0;
  let maxDepth      = 0;
  let totalFrameLike   = 0;
  let componentCount   = 0;
  let autoLayoutCount  = 0;
  let numberedNameCount = 0;
  let effectCount        = 0;
  let groupCount         = 0;
  let unusualSpacingCount = 0;
  const unusualSpacingSet = new Set<number>();
  const typefaceSet       = new Set<string>();
  let accessibilityViolations = 0;
  const accessibilityDetails: string[] = [];
  let totalStyles = 0;

  const accessibilityNodes: NodeRef[] = [];
  const unlinkedStyleNodes: NodeRef[] = [];
  const offGridNodes:        NodeRef[] = [];
  const numberedNameNodes:   NodeRef[] = [];
  const noAutoLayoutNodes:   NodeRef[] = [];

  function addRef(list: NodeRef[], node: SceneNode, details?: string) {
    if (!list.find((r) => r.id === node.id)) {
      list.push({ id: node.id, name: node.name, details });
    }
  }

  function traverse(node: BaseNode, depth: number): void {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

    // ── Numbered layer names ──
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

    // ── Effects ──
    if ("effects" in node && node.effects.length > 0) {
      effectCount += node.effects.length;
    }

    // ── Groups ──
    if (node.type === "GROUP") {
      groupCount++;
    }

    // ── Off-grid spacing ──
    if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
      const f = node as FrameNode;
      const ALLOWED_SPACING = new Set([
        1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256,
        512,
      ]);
      const SPACING_LABELS: [number, string][] = [
        [f.paddingLeft,   "L"],
        [f.paddingRight,  "R"],
        [f.paddingTop,    "T"],
        [f.paddingBottom, "B"],
        [f.itemSpacing,   "Gap"],
      ];

      const badProps: string[] = [];
      for (const [val, label] of SPACING_LABELS) {
        if (val > 0 && !ALLOWED_SPACING.has(val)) {
          unusualSpacingCount++;
          unusualSpacingSet.add(val);
          badProps.push(`${label}: ${val}`);
        }
      }
      if (badProps.length > 0) {
        addRef(offGridNodes, node, badProps.join("  ·  "));
      }
    }

    // ── Typefaces ──
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
    componentProportion:
      totalFrameLike > 0 ? componentCount / totalFrameLike : 0,
    autoLayoutProportion:
      totalFrameLike > 0 ? autoLayoutCount / totalFrameLike : 0,
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