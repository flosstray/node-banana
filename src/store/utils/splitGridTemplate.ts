/**
 * Split Grid Template Utilities
 *
 * Pure helpers for the split-grid node's per-cell template system.
 * A template describes the set of nodes created for every split image;
 * materialization instantiates it once per grid cell as real canvas nodes,
 * wrapped in a group.
 */

import type {
  NodeType,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeData,
  NodeGroup,
  GroupColor,
  SplitGridNodeData,
  SplitGridTemplate,
  SplitGridCell,
} from "@/types";
import { MODEL_DISPLAY_NAMES } from "@/types";
import {
  createDefaultNodeData,
  createDefaultSplitGridTemplate,
  defaultNodeDimensions,
  SPLIT_GRID_BASE_NODE_ID,
} from "./nodeDefaults";

export { createDefaultSplitGridTemplate, SPLIT_GRID_BASE_NODE_ID };

export const MIN_GRID_DIMENSION = 1;
export const MAX_GRID_DIMENSION = 8;

/**
 * Normalizes a grid dimension from untrusted data (AI-generated workflows,
 * hand-edited JSON, chat edit-operations) to a valid integer. Every consumer
 * of gridRows/gridCols must clamp identically, or staleness keys drift and
 * cells rebuild on every run.
 */
export function clampGridDimension(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return MIN_GRID_DIMENSION;
  return Math.min(MAX_GRID_DIMENSION, Math.max(MIN_GRID_DIMENSION, Math.round(num)));
}

/**
 * The classic pre-template layout: image + prompt feeding a generate node.
 * Optional legacy generate settings become overrides on the generate node.
 */
export function createClassicSplitGridTemplate(
  defaultPrompt = "",
  generateSettings?: SplitGridNodeData["generateSettings"]
): SplitGridTemplate {
  const generateOverrides = generateSettings
    ? {
        ...generateSettings,
        selectedModel: {
          provider: "gemini",
          modelId: generateSettings.model,
          displayName: MODEL_DISPLAY_NAMES[generateSettings.model] || generateSettings.model,
        },
      }
    : undefined;
  return {
    baseNodeId: SPLIT_GRID_BASE_NODE_ID,
    nodes: [
      {
        id: SPLIT_GRID_BASE_NODE_ID,
        type: "imageInput",
        position: { x: 0, y: 0 },
      },
      {
        id: "cell-prompt",
        type: "prompt",
        position: { x: 0, y: 310 },
        data: defaultPrompt ? { prompt: defaultPrompt } : undefined,
      },
      {
        id: "cell-generate",
        type: "nanoBanana",
        position: { x: 340, y: 0 },
        data: generateOverrides,
      },
    ],
    edges: [
      {
        id: "cell-image-generate",
        source: SPLIT_GRID_BASE_NODE_ID,
        sourceHandle: "image",
        target: "cell-generate",
        targetHandle: "image",
      },
      {
        id: "cell-prompt-generate",
        source: "cell-prompt",
        sourceHandle: "text",
        target: "cell-generate",
        targetHandle: "text",
      },
    ],
  };
}

/**
 * Returns the node's template. Legacy saves that predate templates map onto
 * the classic image+prompt+generate layout (so the editor reflects what the
 * node actually built); anything else falls back to the image-only default.
 */
export function getSplitGridTemplate(data: SplitGridNodeData): SplitGridTemplate {
  // A template whose base node is missing would materialize cells that can
  // never be populated (and re-materialize on every run) — treat as invalid.
  if (
    data.template &&
    data.template.nodes.some((node) => node.id === data.template!.baseNodeId)
  ) {
    return data.template;
  }
  if (hasLegacyCellsOnly(data)) {
    return createClassicSplitGridTemplate(data.defaultPrompt, data.generateSettings);
  }
  return createDefaultSplitGridTemplate();
}

/**
 * Stable staleness key for a rows/cols/template configuration.
 */
export function computeMaterializedKey(
  rows: number,
  cols: number,
  template: SplitGridTemplate
): string {
  return JSON.stringify({
    rows,
    cols,
    baseNodeId: template.baseNodeId,
    nodes: [...template.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...template.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * Returns materialized cells, mapping legacy childNodeIds onto the cell shape
 * for workflows saved before templates existed.
 */
export function getSplitGridCells(data: SplitGridNodeData): SplitGridCell[] {
  if (data.cells && data.cells.length > 0) return data.cells;
  if (Array.isArray(data.childNodeIds) && data.childNodeIds.length > 0) {
    return data.childNodeIds.map((child) => ({
      baseImageNodeId: child.imageInput,
      nodeIds: [child.imageInput, child.prompt, child.nanoBanana].filter(Boolean),
    }));
  }
  return [];
}

/**
 * True when the node tracks cells via the legacy childNodeIds field only.
 * Legacy cells are populated in place and never auto-rebuilt — until the user
 * saves a template, which upgrades the node to the cells-based flow.
 */
export function hasLegacyCellsOnly(data: SplitGridNodeData): boolean {
  return (
    (data.cells?.length ?? 0) === 0 &&
    Array.isArray(data.childNodeIds) &&
    data.childNodeIds.length > 0
  );
}

/**
 * True when the node's materialized cells no longer match its current
 * rows/cols/template configuration (or were never created).
 *
 * `ignoreLegacy` skips the legacy-cells guard: used when the user explicitly
 * saves a template, upgrading a legacy node to the cells-based flow.
 * `template` evaluates against a not-yet-saved template (editor apply).
 */
export function needsMaterialization(
  data: SplitGridNodeData,
  existingNodeIds: Set<string>,
  options?: { ignoreLegacy?: boolean; template?: SplitGridTemplate }
): boolean {
  const rows = clampGridDimension(data.gridRows);
  const cols = clampGridDimension(data.gridCols);
  if (hasLegacyCellsOnly(data) && !options?.template) {
    if (options?.ignoreLegacy) return true;
    // Legacy cells populate in place while the grid still matches them;
    // a rows/cols change requires a rebuild or the slices would misalign
    return data.childNodeIds.length !== rows * cols;
  }
  const cells = data.cells ?? [];
  if (cells.length === 0) return true;
  const template = options?.template ?? getSplitGridTemplate(data);
  const key = computeMaterializedKey(rows, cols, template);
  if (data.materializedKey !== key) return true;
  if (cells.length !== rows * cols) return true;
  // A partially deleted grid is intentional pruning; rebuild only when every
  // cell's base image node is gone
  return cells.every((cell) => !existingNodeIds.has(cell.baseImageNodeId));
}

export interface BuildCellInstancesOptions {
  splitNode: WorkflowNode;
  template: SplitGridTemplate;
  rows: number;
  cols: number;
  makeNodeId: (type: NodeType) => string;
  makeGroupId: () => string;
  groupColor: GroupColor;
  makeEdgeData: (connection: {
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }) => Record<string, unknown>;
}

export interface CellInstancesResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  cells: SplitGridCell[];
}

const CLUSTER_GAP = 60;
const SPLIT_NODE_MARGIN = 100;
const GROUP_PADDING = 20;

function templateNodeDimensions(
  templateNode: Pick<SplitGridTemplate["nodes"][number], "type" | "size">
): { width: number; height: number } {
  return templateNode.size ?? defaultNodeDimensions[templateNode.type] ?? { width: 300, height: 280 };
}

/**
 * Instantiates the template once per grid cell, producing real nodes, edges
 * (intra-cell wiring + a reference edge from the split node to each cell's
 * base image node), and one group per cell.
 */
export function buildCellInstances(options: BuildCellInstancesOptions): CellInstancesResult {
  const { splitNode, template, rows, cols, makeNodeId, makeGroupId, groupColor, makeEdgeData } =
    options;

  // Template bounding box (normalizes arbitrary editor positions to offsets)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const templateNode of template.nodes) {
    const { width, height } = templateNodeDimensions(templateNode);
    minX = Math.min(minX, templateNode.position.x);
    minY = Math.min(minY, templateNode.position.y);
    maxX = Math.max(maxX, templateNode.position.x + width);
    maxY = Math.max(maxY, templateNode.position.y + height);
  }
  const clusterWidth = maxX - minX;
  const clusterHeight = maxY - minY;

  const splitWidth =
    (splitNode.style?.width as number) ??
    splitNode.measured?.width ??
    templateNodeDimensions({ type: "splitGrid" }).width;
  const startX = splitNode.position.x + splitWidth + SPLIT_NODE_MARGIN;
  const startY = splitNode.position.y;

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const groups: Record<string, NodeGroup> = {};
  const cells: SplitGridCell[] = [];

  for (let index = 0; index < rows * cols; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const originX = startX + col * (clusterWidth + GROUP_PADDING * 2 + CLUSTER_GAP);
    const originY = startY + row * (clusterHeight + GROUP_PADDING * 2 + CLUSTER_GAP);

    // Instantiate nodes
    const idMap = new Map<string, string>();
    const groupId = makeGroupId();
    for (const templateNode of template.nodes) {
      const nodeId = makeNodeId(templateNode.type);
      idMap.set(templateNode.id, nodeId);
      const { width, height } = templateNodeDimensions(templateNode);
      const defaultData = createDefaultNodeData(templateNode.type);
      const data = templateNode.data
        ? ({ ...defaultData, ...templateNode.data } as WorkflowNodeData)
        : defaultData;
      nodes.push({
        id: nodeId,
        type: templateNode.type,
        position: {
          x: originX + (templateNode.position.x - minX),
          y: originY + (templateNode.position.y - minY),
        },
        data,
        style: { width, height },
        groupId,
      });
    }

    // Intra-cell edges
    for (const templateEdge of template.edges) {
      const source = idMap.get(templateEdge.source);
      const target = idMap.get(templateEdge.target);
      if (!source || !target) continue;
      const connection = {
        source,
        sourceHandle: templateEdge.sourceHandle,
        target,
        targetHandle: templateEdge.targetHandle,
      };
      edges.push({
        id: `edge-${source}-${target}-${templateEdge.sourceHandle}-${templateEdge.targetHandle}`,
        ...connection,
        data: makeEdgeData(connection),
      } as WorkflowEdge);
    }

    // Reference edge from the split node to this cell's base image node
    const baseImageNodeId = idMap.get(template.baseNodeId);
    if (baseImageNodeId) {
      const referenceConnection = {
        source: splitNode.id,
        sourceHandle: "reference",
        target: baseImageNodeId,
        targetHandle: "reference",
      };
      edges.push({
        id: `edge-${splitNode.id}-${baseImageNodeId}-reference-reference`,
        ...referenceConnection,
        type: "reference",
        data: makeEdgeData(referenceConnection),
      } as WorkflowEdge);
    }

    // Group wrapping the cell
    groups[groupId] = {
      id: groupId,
      name: `Cell ${row + 1}-${col + 1}`,
      color: groupColor,
      position: { x: originX - GROUP_PADDING, y: originY - GROUP_PADDING },
      size: {
        width: clusterWidth + GROUP_PADDING * 2,
        height: clusterHeight + GROUP_PADDING * 2,
      },
    };

    cells.push({
      baseImageNodeId: baseImageNodeId ?? "",
      nodeIds: template.nodes.map((templateNode) => idMap.get(templateNode.id)!),
      groupId,
    });
  }

  return { nodes, edges, groups, cells };
}
