figma.showUI(__html__, { width: 700, height: 700 });

const SPACING_GRID: number = 8;

interface AnalysisResult {
  totalNodes: number;
  maxDepth: number;
  componentProportion: number;
  autoLayoutProportion: number;
  numberedNameCount: number;
  effectCount: number;
  groupCount: number;
  unusualSpacingCount: number;
  unusualSpacingValues: number[];
  typefaceCount: number;
  typefaceNames: string[];
}

type FlowRef = { nodeId: string; name: string };

function isContainerNode(node: BaseNode | null): node is BaseNode & ChildrenMixin {
  return !!node && "children" in node;
}

function isFrameLikeNode(node: BaseNode | null): node is SceneNode & ChildrenMixin {
  return !!node && (
    node.type === "FRAME" ||
    node.type === "GROUP" ||
    node.type === "SECTION" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" ||
    node.type === "INSTANCE"
  );
}

function getContainingScreen(node: BaseNode | null): (SceneNode & ChildrenMixin) | null {
  let current: BaseNode | null = node;

  while (current) {
    if (isFrameLikeNode(current)) {
      return current;
    }
    current = current.parent;
  }

  return null;
}

async function collectReactionDestinationsDeep(node: BaseNode): Promise<string[]> {
  const destinationIds = new Set<string>();

  async function walk(current: BaseNode): Promise<void> {
    if ("reactions" in current) {
      const reactions = (current as SceneNode & { reactions: Reaction[] }).reactions;
      for (const reaction of reactions) {
        const action = reaction.action as { type?: string; destinationId?: string } | null;
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

async function getConnectedFlowNodes(startNode: BaseNode): Promise<(BaseNode & ChildrenMixin)[]> {
  const startScreen = getContainingScreen(startNode);
  if (!startScreen) return [];

  const visitedScreenIds = new Set<string>();
  const queuedScreenIds = new Set<string>([startScreen.id]);
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
      const destNode = await figma.getNodeByIdAsync(destId);
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
    const containsSelectedNode = connectedNodes.some((n) => ancestorIds.has(n.id));

    if (containsSelectedNode) {
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

figma.on("selectionchange", () => {
  sendFlowsForSelection();
});

figma.ui.onmessage = async (msg: { type: string; nodeId?: string }) => {
  if (msg.type === "ui-ready") {
    await sendFlowsForSelection();
    return;
  }

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
    if (!isContainerNode(root)) {
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
      data: mergeResults(flowNodes.map(analyzeNode)),
      mode: "flow",
      frameCount: flowNodes.length,
    });
    return;
  }
};

function mergeResults(results: AnalysisResult[]): AnalysisResult {
  const allTypefaces = new Set<string>();
  const allSpacingVals = new Set<number>();

  let totalNodes = 0;
  let maxDepth = 0;
  let totalFrameLike = 0;
  let totalComponents = 0;
  let totalAutoLayout = 0;
  let numberedNameCount = 0;
  let effectCount = 0;
  let groupCount = 0;
  let unusualSpacingCount = 0;

  for (const r of results) {
    totalNodes += r.totalNodes;
    maxDepth = Math.max(maxDepth, r.maxDepth);
    numberedNameCount += r.numberedNameCount;
    effectCount += r.effectCount;
    groupCount += r.groupCount;
    unusualSpacingCount += r.unusualSpacingCount;

    r.typefaceNames.forEach((t) => allTypefaces.add(t));
    r.unusualSpacingValues.forEach((v) => allSpacingVals.add(v));
  }

  for (const nodeResult of results) {
    const estimatedFrameLikeCount =
      nodeResult.componentProportion > 0 || nodeResult.autoLayoutProportion > 0
        ? 1
        : 1;

    totalFrameLike += estimatedFrameLikeCount;
    totalComponents += nodeResult.componentProportion;
    totalAutoLayout += nodeResult.autoLayoutProportion;
  }

  return {
    totalNodes,
    maxDepth,
    componentProportion: results.length ? avg(results.map((r) => r.componentProportion)) : 0,
    autoLayoutProportion: results.length ? avg(results.map((r) => r.autoLayoutProportion)) : 0,
    numberedNameCount,
    effectCount,
    groupCount,
    unusualSpacingCount,
    unusualSpacingValues: Array.from(allSpacingVals).sort((a, b) => a - b),
    typefaceCount: allTypefaces.size,
    typefaceNames: Array.from(allTypefaces).sort(),
  };
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function analyzeNode(root: BaseNode & ChildrenMixin): AnalysisResult {
  const grid = SPACING_GRID;

  let totalNodes = 0;
  let maxDepth = 0;
  let totalFrameLike = 0;
  let componentCount = 0;
  let autoLayoutCount = 0;
  let numberedNameCount = 0;
  let effectCount = 0;
  let groupCount = 0;
  let unusualSpacingCount = 0;

  const unusualSpacingSet = new Set<number>();
  const typefaceSet = new Set<string>();

  function traverse(node: BaseNode, depth: number): void {
    totalNodes++;
    maxDepth = Math.max(maxDepth, depth);

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

      if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
        autoLayoutCount++;
      }
    }

    if ("effects" in node && (node as SceneNode & { effects: Effect[] }).effects.length > 0) {
      effectCount += (node as SceneNode & { effects: Effect[] }).effects.length;
    }

    if (node.type === "GROUP") {
      groupCount++;
    }

    if ("layoutMode" in node && (node as FrameNode).layoutMode !== "NONE") {
      const f = node as FrameNode;
      for (const val of [f.paddingLeft, f.paddingRight, f.paddingTop, f.paddingBottom, f.itemSpacing]) {
        if (val > 0 && val % grid !== 0) {
          unusualSpacingCount++;
          unusualSpacingSet.add(val);
        }
      }
    }

    if (node.type === "TEXT") {
      const textNode = node as TextNode;

      if (typeof textNode.fontName !== "symbol") {
        typefaceSet.add((textNode.fontName as FontName).family);
      } else {
        for (let i = 0; i < textNode.characters.length; i++) {
          const fn = textNode.getRangeFontName(i, i + 1);
          if (typeof fn !== "symbol") {
            typefaceSet.add((fn as FontName).family);
          }
        }
      }
    }

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
    componentProportion: totalFrameLike > 0 ? componentCount / totalFrameLike : 0,
    autoLayoutProportion: totalFrameLike > 0 ? autoLayoutCount / totalFrameLike : 0,
    numberedNameCount,
    effectCount,
    groupCount,
    unusualSpacingCount,
    unusualSpacingValues: Array.from(unusualSpacingSet).sort((a, b) => a - b),
    typefaceCount: typefaceSet.size,
    typefaceNames: Array.from(typefaceSet).sort(),
  };
}