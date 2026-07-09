import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitGridTemplateModal } from "@/components/splitgrid/SplitGridTemplateModal";
import { TEMPLATE_NODE_CATALOG } from "@/components/splitgrid/templateCatalog";
import type { SplitGridNodeData } from "@/types";

// Mock the workflow store (selector-passthrough pattern)
const mockUpdateNodeData = vi.fn();
const mockMaterializeSplitGridCells = vi.fn();
const mockIncrementModalCount = vi.fn();
const mockDecrementModalCount = vi.fn();
let mockIsRunning = false;

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) =>
    selector({
      updateNodeData: mockUpdateNodeData,
      materializeSplitGridCells: mockMaterializeSplitGridCells,
      incrementModalCount: mockIncrementModalCount,
      decrementModalCount: mockDecrementModalCount,
      isRunning: mockIsRunning,
    }),
}));

const NODE_ID = "split-grid-node-1";
const PROMPT_TEXTAREA_PLACEHOLDER = "Describe what to generate...";
const GENERATE_WARNING = "Generate Image nodes need a Prompt connected to their text input";

function createNodeData(overrides: Partial<SplitGridNodeData> = {}): SplitGridNodeData {
  return {
    sourceImage: null,
    gridRows: 2,
    gridCols: 3,
    targetCount: 6,
    defaultPrompt: "",
    generateSettings: {
      aspectRatio: "1:1",
      resolution: "1K",
      model: "nano-banana",
      useGoogleSearch: false,
      useImageSearch: false,
    },
    childNodeIds: [],
    isConfigured: false,
    status: "idle",
    error: null,
    ...overrides,
  };
}

function renderModal(
  options: { nodeData?: Partial<SplitGridNodeData>; onClose?: () => void } = {}
) {
  const onClose = options.onClose ?? vi.fn();
  const result = render(
    <SplitGridTemplateModal
      nodeId={NODE_ID}
      nodeData={createNodeData(options.nodeData)}
      onClose={onClose}
    />
  );
  return { ...result, onClose };
}

describe("SplitGridTemplateModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsRunning = false;
  });

  describe("Rendering", () => {
    it("should render the modal title", () => {
      renderModal();

      expect(screen.getByText("Cell Node Set")).toBeInTheDocument();
    });

    it("should not render add-node toolbar chips (nodes are added via handle drag)", () => {
      renderModal();

      for (const entry of TEMPLATE_NODE_CATALOG) {
        if (entry.label === "Prompt" || entry.label === "Generate Image") continue; // preset labels overlap
        expect(screen.queryByRole("button", { name: entry.label })).not.toBeInTheDocument();
      }
    });

    it("should render presets in the header", () => {
      renderModal();

      expect(screen.getByText("Presets")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Image only" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prompt + Generate" })).toBeInTheDocument();
    });

    it("should render the base image node with its floating title", () => {
      renderModal();

      expect(screen.getByText("Image Input")).toBeInTheDocument();
      expect(screen.getByText("Split image lands here")).toBeInTheDocument();
      expect(screen.getByText("1 per cell")).toBeInTheDocument();
    });

    it("should render both preset buttons", () => {
      renderModal();

      expect(screen.getByRole("button", { name: "Image only" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Prompt + Generate" })).toBeInTheDocument();
    });
  });

  describe("Modal Count", () => {
    it("should increment the modal count on mount", () => {
      renderModal();

      expect(mockIncrementModalCount).toHaveBeenCalledTimes(1);
      expect(mockDecrementModalCount).not.toHaveBeenCalled();
    });

    it("should decrement the modal count on unmount", () => {
      const { unmount } = renderModal();

      unmount();

      expect(mockDecrementModalCount).toHaveBeenCalledTimes(1);
    });
  });

  describe("Adding Nodes", () => {
    it("adds prompt and generate cards when the classic preset is applied", () => {
      renderModal();

      expect(
        screen.queryByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      expect(screen.getByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
    });
  });

  describe("Footer", () => {
    it("should show 'Apply to 6 cells' for a 2x3 grid", () => {
      renderModal({ nodeData: { gridRows: 2, gridCols: 3 } });

      expect(screen.getByRole("button", { name: "Apply to 6 cells" })).toBeInTheDocument();
    });

    it("should show singular 'Apply to 1 cell' for a 1x1 grid", () => {
      renderModal({ nodeData: { gridRows: 1, gridCols: 1 } });

      expect(screen.getByRole("button", { name: "Apply to 1 cell" })).toBeInTheDocument();
    });
  });

  describe("Apply", () => {
    it("should materialize with force and the built template in one call, then close", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      expect(mockMaterializeSplitGridCells).toHaveBeenCalledWith(NODE_ID, {
        force: true,
        template: expect.objectContaining({ baseNodeId: "cell-image" }),
      });
      // Template save and materialization are atomic (single undo entry) —
      // no separate updateNodeData call
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("should include preset nodes in the applied template", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      const template = options.template;
      expect(template.nodes).toHaveLength(3);
      expect(template.nodes.map((node: { type: string }) => node.type)).toEqual(
        expect.arrayContaining(["imageInput", "prompt", "nanoBanana"])
      );
      // Generate node carries concrete settings, like a main-canvas node
      const generate = template.nodes.find((node: { type: string }) => node.type === "nanoBanana");
      expect(generate.data).toMatchObject({
        selectedModel: expect.objectContaining({ modelId: expect.any(String) }),
      });
    });

    it("preserves legacy generate settings and prompt when the classic preset is applied", () => {
      renderModal({
        nodeData: {
          defaultPrompt: "make it pop",
          generateSettings: {
            aspectRatio: "16:9",
            resolution: "2K",
            model: "nano-banana-pro",
            useGoogleSearch: true,
            useImageSearch: false,
          },
        },
      });

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply to 6 cells" }));

      const [, options] = mockMaterializeSplitGridCells.mock.calls[0];
      const template = options.template;
      const generate = template.nodes.find(
        (node: { type: string }) => node.type === "nanoBanana"
      );
      expect(generate.data).toMatchObject({
        aspectRatio: "16:9",
        resolution: "2K",
        selectedModel: expect.objectContaining({ modelId: "nano-banana-pro" }),
      });
      const promptNode = template.nodes.find(
        (node: { type: string }) => node.type === "prompt"
      );
      expect(promptNode.data).toMatchObject({ prompt: "make it pop" });
    });
  });

  describe("Unsaved changes", () => {
    it("asks before discarding when Escape is pressed after edits", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText("Discard changes?")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps editing when the user declines the discard prompt", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

      expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("While a workflow is running", () => {
    it("disables Apply so cells cannot be rebuilt mid-run", () => {
      mockIsRunning = true;
      renderModal();

      const applyButton = screen.getByRole("button", { name: "Apply to 6 cells" });
      expect(applyButton).toBeDisabled();

      fireEvent.click(applyButton);
      expect(mockMaterializeSplitGridCells).not.toHaveBeenCalled();
    });
  });

  describe("Cancel", () => {
    it("should call onClose without saving the template", () => {
      const { onClose } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
      expect(mockMaterializeSplitGridCells).not.toHaveBeenCalled();
    });
  });

  describe("Escape Key", () => {
    it("should call onClose when Escape is pressed", () => {
      const { onClose } = renderModal();

      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockUpdateNodeData).not.toHaveBeenCalled();
    });
  });

  describe("Presets", () => {
    it("should show Prompt and Generate Image cards after applying 'Prompt + Generate'", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      // Prompt card body (textarea) and Generate card body (Model select) are unique to the canvas
      expect(screen.getByPlaceholderText(PROMPT_TEXTAREA_PLACEHOLDER)).toBeInTheDocument();
      expect(screen.getByText("Model")).toBeInTheDocument();
      // Floating card titles
      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });
  });

  describe("Generate Prompt Warning", () => {
    it("should not show the warning initially", () => {
      renderModal();

      expect(screen.queryByText(GENERATE_WARNING)).not.toBeInTheDocument();
    });

    it("should warn when a stored template has a Generate Image node with no prompt", () => {
      renderModal({
        nodeData: {
          template: {
            baseNodeId: "cell-image",
            nodes: [
              { id: "cell-image", type: "imageInput", position: { x: 0, y: 0 } },
              { id: "cell-generate", type: "nanoBanana", position: { x: 340, y: 0 } },
            ],
            edges: [
              {
                id: "cell-image-generate",
                source: "cell-image",
                sourceHandle: "image",
                target: "cell-generate",
                targetHandle: "image",
              },
            ],
          },
        },
      });

      expect(screen.getByText(GENERATE_WARNING)).toBeInTheDocument();
    });

    it("should not warn when the preset wires a prompt into the generate node", () => {
      renderModal();

      fireEvent.click(screen.getByRole("button", { name: "Prompt + Generate" }));

      expect(screen.queryByText(GENERATE_WARNING)).not.toBeInTheDocument();
    });
  });
});
