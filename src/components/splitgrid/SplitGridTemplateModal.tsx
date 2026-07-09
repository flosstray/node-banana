"use client";

/**
 * Split Grid cell template editor — a mini node graph in a modal.
 *
 * Users design the set of nodes created for every split image: the base cell
 * image node is always present, and new nodes are added exactly like on the
 * main canvas — drag from a handle into empty space and pick from the
 * connection menu. Confirming saves the template and materializes one node
 * group per cell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeTypes,
} from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import type {
  LLMGenerateNodeData,
  NanoBananaNodeData,
  NodeType,
  SplitGridNodeData,
  SplitGridTemplate,
} from "@/types";
import { createDefaultNodeData, defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import {
  clampGridDimension,
  createClassicSplitGridTemplate,
  createDefaultSplitGridTemplate,
  getSplitGridTemplate,
} from "@/store/utils/splitGridTemplate";
import {
  getTemplateEntry,
  getTemplateNodeIcon,
  TEMPLATE_NODE_CATALOG,
  type TemplateCatalogEntry,
  type TemplateHandleKind,
} from "./templateCatalog";
import {
  GEMINI_IMAGE_MODELS,
  SplitGridTemplateNode,
  TemplateEditorContext,
  type TemplateNodeData,
  type TemplateRFNode,
} from "./TemplateNodes";

const nodeTypes: NodeTypes = {
  splitGridTemplateNode: SplitGridTemplateNode,
};

const EDGE_COLOR: Record<TemplateHandleKind, string> = {
  image: "#0d9668",
  text: "#2563eb",
};

function edgeStyleFor(sourceHandle: string | null | undefined): React.CSSProperties {
  const kind = (sourceHandle === "text" ? "text" : "image") as TemplateHandleKind;
  return { stroke: EDGE_COLOR[kind], strokeWidth: 2 };
}

/**
 * Snapshot of the user's sticky generate defaults — a template generate node
 * starts from the same settings a Generate Image node gets on the main canvas.
 */
function seedGenerateOverrides(): Record<string, unknown> {
  const defaults = createDefaultNodeData("nanoBanana") as NanoBananaNodeData;
  const seed: Record<string, unknown> = {
    model: defaults.model,
    selectedModel:
      defaults.selectedModel ?? {
        provider: "gemini",
        modelId: defaults.model,
        displayName:
          GEMINI_IMAGE_MODELS.find((m) => m.value === defaults.model)?.label || defaults.model,
      },
    aspectRatio: defaults.aspectRatio,
    resolution: defaults.resolution,
    useGoogleSearch: defaults.useGoogleSearch,
    useImageSearch: defaults.useImageSearch,
  };
  if (defaults.parameters && Object.keys(defaults.parameters).length > 0) {
    seed.parameters = defaults.parameters;
  }
  return seed;
}

/** LLM template nodes start from the same defaults as a main-canvas LLM node */
function seedLlmOverrides(): Record<string, unknown> {
  const defaults = createDefaultNodeData("llmGenerate") as LLMGenerateNodeData;
  return {
    provider: defaults.provider,
    model: defaults.model,
    temperature: defaults.temperature,
    maxTokens: defaults.maxTokens,
  };
}

function seedOverridesFor(type: NodeType): Record<string, unknown> {
  if (type === "nanoBanana") return seedGenerateOverrides();
  if (type === "llmGenerate") return seedLlmOverrides();
  return {};
}

function editorNodeDimensions(type: NodeType): { width: number; height: number } {
  return defaultNodeDimensions[type] ?? { width: 300, height: 280 };
}

function templateToRfNodes(
  template: SplitGridTemplate,
  sourceImage: string | null
): TemplateRFNode[] {
  return template.nodes.map((templateNode) => {
    // Nodes with an in-flow settings panel auto-grow to fit it on mount
    const dims = templateNode.size ?? editorNodeDimensions(templateNode.type);
    const isBase = templateNode.id === template.baseNodeId;
    let overrides = { ...(templateNode.data ?? {}) };
    // Generate/LLM nodes always show concrete settings, like the main canvas
    if (Object.keys(overrides).length === 0) {
      overrides = seedOverridesFor(templateNode.type);
    }
    return {
      id: templateNode.id,
      type: "splitGridTemplateNode",
      position: { ...templateNode.position },
      deletable: !isBase,
      style: { width: dims.width, height: dims.height },
      data: {
        nodeType: templateNode.type,
        overrides,
        isBase,
        sourceImage: isBase ? sourceImage : undefined,
      } satisfies TemplateNodeData,
    };
  });
}

function templateToRfEdges(template: SplitGridTemplate): Edge[] {
  return template.edges.map((templateEdge) => ({
    id: templateEdge.id,
    source: templateEdge.source,
    sourceHandle: templateEdge.sourceHandle,
    target: templateEdge.target,
    targetHandle: templateEdge.targetHandle,
    style: edgeStyleFor(templateEdge.sourceHandle),
  }));
}

/** Serialize editor state back into a template (also used for dirty checks) */
function serializeTemplate(
  baseNodeId: string,
  rfNodes: TemplateRFNode[],
  rfEdges: Edge[]
): SplitGridTemplate {
  return {
    baseNodeId,
    nodes: rfNodes.map((node) => {
      // Persist the node's real size, minus the editor-only settings panel
      // (real nodes grow their own panel at runtime, like the main canvas)
      const width =
        (node.width as number | undefined) ?? (node.style?.width as number | undefined);
      const rawHeight =
        (node.height as number | undefined) ?? (node.style?.height as number | undefined);
      const panelHeight = node.data._editorPanelHeight ?? 0;
      const size =
        width && rawHeight
          ? { width, height: Math.max(80, rawHeight - panelHeight) }
          : undefined;
      return {
        id: node.id,
        type: node.data.nodeType,
        position: { x: node.position.x, y: node.position.y },
        size,
        data: Object.keys(node.data.overrides).length > 0 ? node.data.overrides : undefined,
      };
    }),
    edges: rfEdges
      .filter((edge) => edge.sourceHandle && edge.targetHandle)
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle!,
        target: edge.target,
        targetHandle: edge.targetHandle!,
      })),
  };
}

interface TemplateDropMenuState {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  fromNodeId: string;
  fromHandleId: TemplateHandleKind;
  fromHandleType: "source" | "target";
}

/** Connection-drop menu — same look and behavior as the main canvas menu */
function TemplateConnectionMenu({
  menu,
  options,
  onSelect,
  onClose,
}: {
  menu: TemplateDropMenuState;
  options: TemplateCatalogEntry[];
  onSelect: (type: NodeType) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % options.length);
          break;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          break;
        case "Enter":
          event.preventDefault();
          if (options[selectedIndex]) onSelect(options[selectedIndex].type);
          break;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [options, selectedIndex, onSelect]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  if (options.length === 0) return null;

  return (
    <div
      ref={menuRef}
      tabIndex={-1}
      className="fixed z-[110] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl overflow-hidden min-w-[160px] outline-none"
      style={{
        left: menu.screen.x,
        top: menu.screen.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div className="px-2 py-1.5 border-b border-neutral-700">
        <span className="text-[10px] text-neutral-400 uppercase tracking-wide">
          Add {menu.fromHandleId} node
        </span>
      </div>
      <div className="py-1">
        {options.map((option, index) => (
          <button
            key={option.type}
            onClick={() => onSelect(option.type)}
            onMouseEnter={() => setSelectedIndex(index)}
            className={`w-full px-3 py-2 text-left text-[11px] font-medium flex items-center gap-2 transition-colors ${
              index === selectedIndex
                ? "bg-neutral-700 text-neutral-100"
                : "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
            }`}
          >
            {getTemplateNodeIcon(option.type)}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface SplitGridTemplateModalProps {
  nodeId: string;
  nodeData: SplitGridNodeData;
  onClose: () => void;
}

function SplitGridTemplateModalInner({ nodeId, nodeData, onClose }: SplitGridTemplateModalProps) {
  const materializeSplitGridCells = useWorkflowStore((state) => state.materializeSplitGridCells);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const incrementModalCount = useWorkflowStore((state) => state.incrementModalCount);
  const decrementModalCount = useWorkflowStore((state) => state.decrementModalCount);

  const initialTemplate = useMemo(() => getSplitGridTemplate(nodeData), [nodeData]);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<TemplateRFNode>(
    templateToRfNodes(initialTemplate, nodeData.sourceImage)
  );
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>(
    templateToRfEdges(initialTemplate)
  );
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [dropMenu, setDropMenu] = useState<TemplateDropMenuState | null>(null);
  // Drags that end over the backdrop synthesize a click on it — only treat a
  // click as backdrop-close when the pointer also went DOWN on the backdrop
  const backdropPointerDownRef = useRef(false);
  const idCounterRef = useRef(0);
  const baseNodeId = initialTemplate.baseNodeId;
  const { fitView, screenToFlowPosition } = useReactFlow();

  const refitSoon = useCallback(() => {
    requestAnimationFrame(() => {
      fitView({ padding: 0.25, maxZoom: 1, duration: 200 });
    });
  }, [fitView]);

  // Freeze the main canvas while the editor is open
  useEffect(() => {
    incrementModalCount();
    return () => decrementModalCount();
  }, [incrementModalCount, decrementModalCount]);

  // Dirty check: compare against the initial template mapped through the same
  // serializer, so an untouched editor is never considered dirty
  const initialSerializedRef = useRef<string | null>(null);
  if (initialSerializedRef.current === null) {
    initialSerializedRef.current = JSON.stringify(
      serializeTemplate(
        baseNodeId,
        templateToRfNodes(initialTemplate, nodeData.sourceImage),
        templateToRfEdges(initialTemplate)
      )
    );
  }
  const isDirty = useCallback(
    () =>
      JSON.stringify(serializeTemplate(baseNodeId, rfNodes, rfEdges)) !==
      initialSerializedRef.current,
    [baseNodeId, rfNodes, rfEdges]
  );

  const requestClose = useCallback(() => {
    if (isDirty()) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  // Escape: drop menu first, then discard confirmation, then close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dropMenu) {
        setDropMenu(null);
      } else if (showDiscardConfirm) {
        setShowDiscardConfirm(false);
      } else {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dropMenu, showDiscardConfirm, requestClose]);

  const setOverrides = useCallback(
    (id: string, overrides: Record<string, unknown>) => {
      setRfNodes((nodes) =>
        nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, overrides } } : node))
      );
    },
    [setRfNodes]
  );
  const editorContext = useMemo(() => ({ setOverrides }), [setOverrides]);

  const makeTemplateNodeId = useCallback(
    (type: NodeType, existing: TemplateRFNode[]): string => {
      const taken = new Set(existing.map((node) => node.id));
      let id: string;
      do {
        id = `tmpl-${type}-${++idCounterRef.current}`;
      } while (taken.has(id));
      return id;
    },
    []
  );

  const applyPreset = useCallback(
    (template: SplitGridTemplate) => {
      setRfNodes(templateToRfNodes(template, nodeData.sourceImage));
      setRfEdges(templateToRfEdges(template));
      idCounterRef.current = 0;
      refitSoon();
    },
    [nodeData.sourceImage, setRfNodes, setRfEdges, refitSoon]
  );

  // Cycles would materialize as cells the scheduler silently never executes
  const createsCycle = useCallback(
    (source: string, target: string): boolean => {
      const stack = [target];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === source) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const edge of rfEdges) {
          if (edge.source === current) stack.push(edge.target);
        }
      }
      return false;
    },
    [rfEdges]
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!source || !target || source === target) return false;
      const sourceNode = rfNodes.find((node) => node.id === source);
      const targetNode = rfNodes.find((node) => node.id === target);
      if (!sourceNode || !targetNode) return false;
      const sourceEntry = getTemplateEntry(sourceNode.data.nodeType);
      const targetEntry = getTemplateEntry(targetNode.data.nodeType);
      const output = sourceEntry.outputs.find((handle) => handle.id === sourceHandle);
      const input = targetEntry.inputs.find((handle) => handle.id === targetHandle);
      if (!output || !input || output.id !== input.id) return false;
      return !createsCycle(source, target);
    },
    [rfNodes, createsCycle]
  );

  const addConnectedEdge = useCallback(
    (connection: Connection) => {
      setRfEdges((edges) => {
        let next = edges;
        // Text inputs accept a single connection — replace the existing one
        if (connection.targetHandle === "text") {
          next = next.filter(
            (edge) =>
              !(edge.target === connection.target && edge.targetHandle === connection.targetHandle)
          );
        }
        return addEdge({ ...connection, style: edgeStyleFor(connection.sourceHandle) }, next);
      });
    },
    [setRfEdges]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!isValidConnection(connection)) return;
      addConnectedEdge(connection);
    },
    [isValidConnection, addConnectedEdge]
  );

  // Dropping a connection in empty space opens the add-node menu, main-canvas style
  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid) return;
      const fromHandle = connectionState.fromHandle;
      const fromNode = connectionState.fromNode;
      if (!fromHandle?.id || !fromNode) return;
      const targetElement = event.target as HTMLElement | null;
      if (!targetElement?.closest(".react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      setDropMenu({
        screen: { x: point.clientX, y: point.clientY },
        flow: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        fromNodeId: fromNode.id,
        fromHandleId: (fromHandle.id === "text" ? "text" : "image") as TemplateHandleKind,
        fromHandleType: fromHandle.type,
      });
    },
    [screenToFlowPosition]
  );

  const dropMenuOptions = useMemo(() => {
    if (!dropMenu) return [];
    return TEMPLATE_NODE_CATALOG.filter((entry) =>
      dropMenu.fromHandleType === "source"
        ? entry.inputs.some((handle) => handle.id === dropMenu.fromHandleId)
        : entry.outputs.some((handle) => handle.id === dropMenu.fromHandleId)
    );
  }, [dropMenu]);

  const handleDropMenuSelect = useCallback(
    (type: NodeType) => {
      if (!dropMenu) return;
      const dims = editorNodeDimensions(type);
      const entry = getTemplateEntry(type);
      const kind = dropMenu.fromHandleId;
      const newId = makeTemplateNodeId(type, rfNodes);

      let position: { x: number; y: number };
      let connection: Connection;
      if (dropMenu.fromHandleType === "source") {
        // Forward drag: align the new node's input handle with the drop point
        const input = entry.inputs.find((handle) => handle.id === kind);
        const handleRatio = input?.top ? parseFloat(input.top) / 100 : 0.5;
        position = { x: dropMenu.flow.x, y: dropMenu.flow.y - dims.height * handleRatio };
        connection = { source: dropMenu.fromNodeId, sourceHandle: kind, target: newId, targetHandle: kind };
      } else {
        // Backward drag: align the new node's output handle with the drop point
        position = { x: dropMenu.flow.x - dims.width, y: dropMenu.flow.y - dims.height / 2 };
        connection = { source: newId, sourceHandle: kind, target: dropMenu.fromNodeId, targetHandle: kind };
      }

      setRfNodes((nodes) => [
        ...nodes,
        {
          id: newId,
          type: "splitGridTemplateNode" as const,
          position,
          deletable: true,
          style: { width: dims.width, height: dims.height },
          data: {
            nodeType: type,
            overrides: seedOverridesFor(type),
            isBase: false,
          } satisfies TemplateNodeData,
        },
      ]);
      addConnectedEdge(connection);
      setDropMenu(null);
    },
    [dropMenu, makeTemplateNodeId, rfNodes, setRfNodes, addConnectedEdge]
  );

  const cellCount =
    clampGridDimension(nodeData.gridRows) * clampGridDimension(nodeData.gridCols);

  // Advisory warnings for templates that would materialize un-runnable cells
  const warnings = useMemo(() => {
    const list: string[] = [];
    const generateMissingPrompt = rfNodes.some(
      (node) =>
        node.data.nodeType === "nanoBanana" &&
        !rfEdges.some((edge) => edge.target === node.id && edge.targetHandle === "text")
    );
    if (generateMissingPrompt) {
      list.push("Generate Image nodes need a Prompt connected to their text input");
    }
    // Image-processing/output nodes are dead (or fail validation) without an image
    const IMAGE_OPTIONAL = new Set(["nanoBanana", "llmGenerate"]);
    const unwired = rfNodes.filter((node) => {
      if (node.data.isBase || IMAGE_OPTIONAL.has(node.data.nodeType)) return false;
      const entry = getTemplateEntry(node.data.nodeType);
      if (!entry.inputs.some((handle) => handle.id === "image")) return false;
      return !rfEdges.some((edge) => edge.target === node.id && edge.targetHandle === "image");
    });
    if (unwired.length > 0) {
      const labels = [...new Set(unwired.map((node) => getTemplateEntry(node.data.nodeType).label))];
      list.push(`${labels.join(", ")} node${unwired.length === 1 ? " is" : "s are"} missing an image input`);
    }
    return list;
  }, [rfNodes, rfEdges]);

  const handleApply = useCallback(() => {
    if (isRunning) return;
    // Single store call: saving the template and rebuilding the cells share
    // one undo checkpoint, so one Cmd+Z reverts the whole apply
    materializeSplitGridCells(nodeId, {
      force: true,
      template: serializeTemplate(baseNodeId, rfNodes, rfEdges),
    });
    onClose();
  }, [isRunning, baseNodeId, rfNodes, rfEdges, nodeId, materializeSplitGridCells, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onWheelCapture={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        backdropPointerDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropPointerDownRef.current) {
          requestClose();
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <div className="relative w-[min(1080px,94vw)] h-[min(720px,88vh)] bg-neutral-800 rounded-xl border border-neutral-700 shadow-2xl overflow-clip flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-neutral-700/60 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-neutral-100">Cell Node Set</h2>
            <p className="text-xs text-neutral-500 mt-0.5 truncate">
              These nodes are created for every split image and grouped per cell
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
              Presets
            </span>
            <button
              onClick={() => applyPreset(createDefaultSplitGridTemplate())}
              className="px-2.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-700 hover:border-neutral-500 rounded-md transition-colors"
            >
              Image only
            </button>
            <button
              onClick={() =>
                applyPreset(
                  createClassicSplitGridTemplate(nodeData.defaultPrompt, nodeData.generateSettings)
                )
              }
              className="px-2.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-700 hover:border-neutral-500 rounded-md transition-colors"
            >
              Prompt + Generate
            </button>
            <div className="w-px h-6 bg-neutral-700 mx-1" />
            <button
              onClick={requestClose}
              className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Mini canvas */}
        <div className="flex-1 min-h-0 relative bg-neutral-900">
          <TemplateEditorContext.Provider value={editorContext}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={handleConnect}
              onConnectEnd={handleConnectEnd}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.5}
              deleteKeyCode={["Backspace", "Delete"]}
              defaultEdgeOptions={{ animated: false }}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#404040" />
              <Controls showInteractive={false} className="!bg-neutral-800 !border-neutral-700 !shadow-none [&>button]:!bg-neutral-800 [&>button]:!border-neutral-700 [&>button]:!text-neutral-300 [&>button:hover]:!bg-neutral-700" />
            </ReactFlow>
          </TemplateEditorContext.Provider>

          {/* Connection drop menu */}
          {dropMenu && (
            <TemplateConnectionMenu
              menu={dropMenu}
              options={dropMenuOptions}
              onSelect={handleDropMenuSelect}
              onClose={() => setDropMenu(null)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-t border-neutral-700/50 shrink-0">
          <div className="text-xs text-neutral-500 min-w-0">
            <span>
              {rfNodes.length} node{rfNodes.length === 1 ? "" : "s"} per cell · {nodeData.gridRows}×{nodeData.gridCols} grid → {cellCount} group{cellCount === 1 ? "" : "s"}
            </span>
            {warnings.map((warning) => (
              <span key={warning} className="ml-3 text-amber-400">
                {warning}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={requestClose}
              className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={isRunning}
              title={isRunning ? "Wait for the current run to finish" : undefined}
              className="px-4 py-2 text-sm bg-white text-neutral-900 rounded-lg hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Apply to {cellCount} cell{cellCount === 1 ? "" : "s"}
            </button>
          </div>
        </div>

        {/* Discard-changes confirmation */}
        {showDiscardConfirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="bg-neutral-800 border border-neutral-600 rounded-lg p-5 mx-4 max-w-sm shadow-xl">
              <h3 className="text-sm font-semibold text-neutral-100">Discard changes?</h3>
              <p className="text-xs text-neutral-400 mt-1">
                Your edits to the cell node set haven&apos;t been applied.
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setShowDiscardConfirm(false)}
                  className="px-3 py-1.5 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
                >
                  Keep editing
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition-colors"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function SplitGridTemplateModal(props: SplitGridTemplateModalProps) {
  // Own provider: isolates the mini canvas from the app-level React Flow store
  return (
    <ReactFlowProvider>
      <SplitGridTemplateModalInner {...props} />
    </ReactFlowProvider>
  );
}
