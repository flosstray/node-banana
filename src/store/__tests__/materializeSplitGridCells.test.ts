/**
 * Integration tests for materializeSplitGridCells through the real Zustand store.
 *
 * Covers template instantiation (nodes, groups, reference edges, node data
 * bookkeeping), no-op behavior when cells are current, rebuild on config
 * change, legacy childNodeIds handling, and undo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { useWorkflowStore } from "../workflowStore";
import {
  createDefaultSplitGridTemplate,
  createClassicSplitGridTemplate,
  computeMaterializedKey,
  getSplitGridTemplate,
} from "../utils/splitGridTemplate";
import type {
  WorkflowNode,
  WorkflowNodeData,
  SplitGridNodeData,
  PromptNodeData,
} from "@/types";

// Mock the Toast hook
vi.mock("@/components/Toast", () => ({
  useToast: {
    getState: () => ({
      show: vi.fn(),
    }),
  },
}));

// Mock the logger
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));

// Mock localStorage for provider/generation defaults
const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage[key];
  }),
  clear: vi.fn(() => {
    Object.keys(mockLocalStorage).forEach((key) => delete mockLocalStorage[key]);
  }),
});

function resetStore() {
  useWorkflowStore.getState().clearWorkflow();
}

const SPLIT_ID = "splitGrid-test-1";

function makeSplitGridNode(data: Partial<SplitGridNodeData> = {}): WorkflowNode {
  return {
    id: SPLIT_ID,
    type: "splitGrid",
    position: { x: 0, y: 0 },
    style: { width: 300, height: 400 },
    data: {
      sourceImage: null,
      gridRows: 2,
      gridCols: 2,
      template: createDefaultSplitGridTemplate(),
      cells: [],
      materializedKey: null,
      targetCount: 4,
      defaultPrompt: "",
      generateSettings: {
        aspectRatio: "1:1",
        resolution: "1K",
        model: "nano-banana-pro",
        useGoogleSearch: false,
        useImageSearch: false,
      },
      childNodeIds: [],
      isConfigured: false,
      status: "idle",
      error: null,
      ...data,
    } as WorkflowNodeData,
  };
}

function makeNode(id: string, type: string): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    position: { x: 0, y: 0 },
    data: {} as WorkflowNodeData,
  };
}

function getSplitData(): SplitGridNodeData {
  const node = useWorkflowStore.getState().nodes.find((n) => n.id === SPLIT_ID);
  return node!.data as SplitGridNodeData;
}

describe("materializeSplitGridCells", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  describe("default template 2x2", () => {
    beforeEach(() => {
      useWorkflowStore.setState({
        nodes: [makeSplitGridNode()],
        edges: [],
      });
    });

    it("creates 4 imageInput nodes, 4 groups, and 4 reference edges", () => {
      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      const imageInputs = state.nodes.filter((n) => n.type === "imageInput");
      expect(imageInputs).toHaveLength(4);
      expect(state.nodes).toHaveLength(5); // split node + 4 cells

      expect(Object.keys(state.groups)).toHaveLength(4);
      expect(
        Object.values(state.groups)
          .map((g) => g.name)
          .sort()
      ).toEqual(["Cell 1-1", "Cell 1-2", "Cell 2-1", "Cell 2-2"]);

      const referenceEdges = state.edges.filter((e) => e.type === "reference");
      expect(referenceEdges).toHaveLength(4);
      expect(state.edges).toHaveLength(4);
      for (const edge of referenceEdges) {
        expect(edge.source).toBe(SPLIT_ID);
        expect(edge.sourceHandle).toBe("reference");
        expect(edge.targetHandle).toBe("reference");
        expect(imageInputs.some((n) => n.id === edge.target)).toBe(true);
      }
    });

    it("updates the split node's cells, materializedKey, targetCount, and isConfigured", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);

      const state = useWorkflowStore.getState();
      const nodeIds = new Set(state.nodes.map((n) => n.id));
      for (const cell of data.cells!) {
        expect(nodeIds.has(cell.baseImageNodeId)).toBe(true);
        expect(cell.nodeIds).toEqual([cell.baseImageNodeId]); // single-node template
        expect(cell.groupId).toBeDefined();
        expect(state.groups[cell.groupId!]).toBeDefined();
      }

      expect(data.materializedKey).toBe(
        computeMaterializedKey(2, 2, getSplitGridTemplate(data))
      );
      expect(data.targetCount).toBe(4);
      expect(data.isConfigured).toBe(true);
      expect(data.childNodeIds).toEqual([]);
    });

    it("is a no-op when cells already match the configuration", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const stateAfterFirst = useWorkflowStore.getState();
      const nodeCount = stateAfterFirst.nodes.length;
      const nodeIds = stateAfterFirst.nodes.map((n) => n.id);
      const groupIds = Object.keys(stateAfterFirst.groups);

      let secondResult = true;
      act(() => {
        secondResult = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(secondResult).toBe(false);
      const state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(nodeCount);
      expect(state.nodes.map((n) => n.id)).toEqual(nodeIds);
      expect(Object.keys(state.groups)).toEqual(groupIds);
    });

    it("rebuilds cells when gridRows changes (old cell nodes and groups removed)", () => {
      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      const oldCellNodeIds = getSplitData().cells!.flatMap((c) => c.nodeIds);
      const oldGroupIds = Object.keys(useWorkflowStore.getState().groups);
      expect(oldCellNodeIds).toHaveLength(4);

      act(() => {
        useWorkflowStore.getState().updateNodeData(SPLIT_ID, { gridRows: 3 });
      });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      const imageInputs = state.nodes.filter((n) => n.type === "imageInput");
      expect(imageInputs).toHaveLength(6); // 3x2
      expect(state.nodes).toHaveLength(7);
      expect(Object.keys(state.groups)).toHaveLength(6);
      expect(state.edges.filter((e) => e.type === "reference")).toHaveLength(6);

      // Old cell nodes and groups are gone
      const currentIds = new Set(state.nodes.map((n) => n.id));
      for (const oldId of oldCellNodeIds) {
        expect(currentIds.has(oldId)).toBe(false);
      }
      for (const oldGroupId of oldGroupIds) {
        expect(state.groups[oldGroupId]).toBeUndefined();
      }

      const data = getSplitData();
      expect(data.cells).toHaveLength(6);
      expect(data.targetCount).toBe(6);
      expect(data.materializedKey).toBe(
        computeMaterializedKey(3, 2, getSplitGridTemplate(data))
      );
    });
  });

  describe("prompt + generate template", () => {
    it("creates 3 nodes per cell wired imageInput->nanoBanana and prompt->nanoBanana", () => {
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({ template: createClassicSplitGridTemplate("cell prompt") }),
        ],
        edges: [],
      });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      expect(state.nodes.filter((n) => n.type === "imageInput")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "prompt")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "nanoBanana")).toHaveLength(4);
      expect(state.nodes).toHaveLength(13); // split + 4 cells * 3 nodes

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);

      for (const cell of data.cells!) {
        expect(cell.nodeIds).toHaveLength(3);
        const cellNodes = state.nodes.filter((n) => cell.nodeIds.includes(n.id));
        const imageNode = cellNodes.find((n) => n.type === "imageInput")!;
        const promptNode = cellNodes.find((n) => n.type === "prompt")!;
        const generateNode = cellNodes.find((n) => n.type === "nanoBanana")!;
        expect(cell.baseImageNodeId).toBe(imageNode.id);

        // imageInput -> nanoBanana (image handles)
        expect(
          state.edges.some(
            (e) =>
              e.source === imageNode.id &&
              e.target === generateNode.id &&
              e.sourceHandle === "image" &&
              e.targetHandle === "image"
          )
        ).toBe(true);

        // prompt -> nanoBanana (text handles)
        expect(
          state.edges.some(
            (e) =>
              e.source === promptNode.id &&
              e.target === generateNode.id &&
              e.sourceHandle === "text" &&
              e.targetHandle === "text"
          )
        ).toBe(true);

        // reference edge split -> base image node
        expect(
          state.edges.some(
            (e) => e.type === "reference" && e.source === SPLIT_ID && e.target === imageNode.id
          )
        ).toBe(true);

        // seeded prompt text from the template
        expect((promptNode.data as PromptNodeData).prompt).toBe("cell prompt");

        // all three nodes share the cell's group
        for (const node of cellNodes) {
          expect(node.groupId).toBe(cell.groupId);
        }
      }

      // 4 cells * (2 intra edges + 1 reference edge)
      expect(state.edges).toHaveLength(12);
    });
  });

  describe("legacy childNodeIds workflows", () => {
    function seedLegacyWorkflow(dims: { gridRows: number; gridCols: number } = { gridRows: 1, gridCols: 1 }) {
      useWorkflowStore.setState({
        nodes: [
          makeSplitGridNode({
            ...dims,
            template: undefined,
            cells: undefined,
            materializedKey: undefined,
            defaultPrompt: "legacy prompt",
            childNodeIds: [
              { imageInput: "legacy-img-1", prompt: "legacy-prompt-1", nanoBanana: "legacy-gen-1" },
            ],
            isConfigured: true,
          }),
          makeNode("legacy-img-1", "imageInput"),
          makeNode("legacy-prompt-1", "prompt"),
          makeNode("legacy-gen-1", "nanoBanana"),
        ],
        edges: [],
      });
    }

    it("returns false for legacy nodes matching their grid without force", () => {
      seedLegacyWorkflow();

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(result).toBe(false);
      const state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(4);
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(true);
    });

    it("rebuilds legacy nodes whose grid no longer matches the child count", () => {
      // 2x2 grid but only one legacy child set: the slices would misalign,
      // so a rebuild (via the classic template) replaces the legacy children
      seedLegacyWorkflow({ gridRows: 2, gridCols: 2 });

      let result = false;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      expect(result).toBe(true);
      const state = useWorkflowStore.getState();
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(false);
      const data = state.nodes.find((n) => n.id === SPLIT_ID)!.data as SplitGridNodeData;
      expect(data.cells).toHaveLength(4);
      // Classic template: image + prompt + generate per cell
      expect(data.cells![0].nodeIds).toHaveLength(3);
    });

    it("rebuilds with force:true, removing legacy child nodes", () => {
      seedLegacyWorkflow({ gridRows: 2, gridCols: 2 });

      let result = false;
      act(() => {
        result = useWorkflowStore
          .getState()
          .materializeSplitGridCells(SPLIT_ID, { force: true });
      });
      expect(result).toBe(true);

      const state = useWorkflowStore.getState();
      // Legacy children are gone
      expect(state.nodes.some((n) => n.id === "legacy-img-1")).toBe(false);
      expect(state.nodes.some((n) => n.id === "legacy-prompt-1")).toBe(false);
      expect(state.nodes.some((n) => n.id === "legacy-gen-1")).toBe(false);

      // Legacy data maps onto the classic template: 3 nodes per cell, 2x2 grid
      expect(state.nodes).toHaveLength(13);
      expect(state.nodes.filter((n) => n.type === "imageInput")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "prompt")).toHaveLength(4);
      expect(state.nodes.filter((n) => n.type === "nanoBanana")).toHaveLength(4);

      const data = getSplitData();
      expect(data.cells).toHaveLength(4);
      expect(data.childNodeIds).toEqual([]);
      expect(data.template).toBeDefined();
      expect(data.isConfigured).toBe(true);
    });
  });

  describe("invalid targets", () => {
    it("returns false for an unknown node id", () => {
      useWorkflowStore.setState({ nodes: [makeSplitGridNode()], edges: [] });

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells("nonexistent");
      });

      expect(result).toBe(false);
      expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    });

    it("returns false when the node is not a splitGrid node", () => {
      useWorkflowStore.setState({
        nodes: [makeNode("prompt-1", "prompt")],
        edges: [],
      });

      let result = true;
      act(() => {
        result = useWorkflowStore.getState().materializeSplitGridCells("prompt-1");
      });

      expect(result).toBe(false);
    });
  });

  describe("undo", () => {
    it("a single undo restores the pre-materialization node and group counts", () => {
      useWorkflowStore.setState({ nodes: [makeSplitGridNode()], edges: [] });

      act(() => {
        useWorkflowStore.getState().materializeSplitGridCells(SPLIT_ID);
      });

      let state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(5);
      expect(Object.keys(state.groups)).toHaveLength(4);
      expect(state.edges).toHaveLength(4);
      expect(state.canUndo).toBe(true);

      act(() => {
        useWorkflowStore.getState().undo();
      });

      state = useWorkflowStore.getState();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0].id).toBe(SPLIT_ID);
      expect(Object.keys(state.groups)).toHaveLength(0);
      expect(state.edges).toHaveLength(0);

      const data = getSplitData();
      expect(data.cells).toEqual([]);
      expect(data.materializedKey).toBeNull();
    });
  });
});
