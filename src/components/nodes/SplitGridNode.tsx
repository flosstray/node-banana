"use client";

import { useCallback, useState, useEffect, useMemo } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData } from "@/types";
import { SplitGridTemplateModal } from "../splitgrid/SplitGridTemplateModal";
import {
  clampGridDimension,
  getSplitGridCells,
  getSplitGridTemplate,
  needsMaterialization,
  MIN_GRID_DIMENSION,
  MAX_GRID_DIMENSION,
} from "@/store/utils/splitGridTemplate";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useShowHandleLabels } from "@/hooks/useShowHandleLabels";
import { HandleLabel } from "./HandleLabel";

type SplitGridNodeType = Node<SplitGridNodeData, "splitGrid">;

interface GridDimFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function GridDimField({ label, value, onChange, disabled }: GridDimFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = useCallback(
    (raw: string) => {
      setDraft(null);
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) onChange(clampGridDimension(parsed));
    },
    [onChange]
  );

  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
        {label}
      </label>
      <div className="flex items-stretch bg-neutral-900 border border-neutral-700 rounded-md overflow-hidden focus-within:border-neutral-500 transition-colors">
        <button
          onClick={() => onChange(clampGridDimension(value - 1))}
          disabled={disabled || value <= MIN_GRID_DIMENSION}
          className="nodrag nopan px-2 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 disabled:text-neutral-700 disabled:hover:bg-transparent transition-colors"
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
          </svg>
        </button>
        <input
          type="text"
          inputMode="numeric"
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          disabled={disabled}
          className="nodrag nopan w-full min-w-0 py-1.5 bg-transparent text-center text-sm font-medium text-neutral-100 focus:outline-none disabled:text-neutral-600"
          aria-label={label}
        />
        <button
          onClick={() => onChange(clampGridDimension(value + 1))}
          disabled={disabled || value >= MAX_GRID_DIMENSION}
          className="nodrag nopan px-2 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 disabled:text-neutral-700 disabled:hover:bg-transparent transition-colors"
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function SplitGridNode({ id, data, selected }: NodeProps<SplitGridNodeType>) {
  const nodeData = data;
  const adaptiveSourceImage = useAdaptiveImageSrc(nodeData.sourceImage, id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [showEditor, setShowEditor] = useState(false);
  const showLabels = useShowHandleLabels(selected);

  const gridRows = clampGridDimension(nodeData.gridRows);
  const gridCols = clampGridDimension(nodeData.gridCols);
  const cellCount = gridRows * gridCols;

  // Reactively track the connected source image
  const hasIncomingImageConnection = useMemo(() => {
    return edges.some((edge) => edge.target === id && edge.targetHandle === "image");
  }, [edges, id]);

  const connectedSourceImage = useMemo(() => {
    if (!hasIncomingImageConnection) return null;
    const { images } = getConnectedInputs(id);
    return images[0] || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIncomingImageConnection, id, getConnectedInputs, nodes]);

  useEffect(() => {
    if (connectedSourceImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: connectedSourceImage });
    }
  }, [connectedSourceImage, id, updateNodeData, nodeData.sourceImage]);

  const templateNodeCount = getSplitGridTemplate(nodeData).nodes.length;
  const cells = getSplitGridCells(nodeData);
  const cellsAreStale = useMemo(() => {
    const existingIds = new Set(nodes.map((node) => node.id));
    return needsMaterialization(nodeData, existingIds);
  }, [nodeData, nodes]);

  const handleRowsChange = useCallback(
    (value: number) => updateNodeData(id, { gridRows: value }),
    [id, updateNodeData]
  );
  const handleColsChange = useCallback(
    (value: number) => updateNodeData(id, { gridCols: value }),
    [id, updateNodeData]
  );

  const handleSplit = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const statusText = nodeData.status === "error"
    ? nodeData.error || "Error"
    : cells.length > 0
      ? cellsAreStale
        ? "Cells out of date — Split rebuilds"
        : `${cells.length} cell group${cells.length === 1 ? "" : "s"}`
      : "Split creates a group per cell";

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        hasError={nodeData.status === "error"}
        minWidth={260}
        minHeight={340}
      >
        {/* Image input handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
          style={{ zIndex: 10 }}
        />
        <HandleLabel label="Image" side="target" color="var(--handle-color-image)" visible={showLabels} />

        {/* Reference output handle for visual links to cell nodes */}
        <Handle
          type="source"
          position={Position.Right}
          id="reference"
          data-handletype="reference"
          className="!bg-gray-500"
          style={{ zIndex: 10 }}
        />
        <HandleLabel label="Ref" side="source" color="#6b7280" visible={showLabels} />

        <div className="flex flex-col gap-2 pt-3 h-full min-h-0">
          {/* Rows / Columns fields */}
          <div className="grid grid-cols-2 gap-2">
            <GridDimField label="Rows" value={gridRows} onChange={handleRowsChange} disabled={isRunning} />
            <GridDimField label="Columns" value={gridCols} onChange={handleColsChange} disabled={isRunning} />
          </div>

          {/* Cell node set editor */}
          <button
            onClick={() => setShowEditor(true)}
            disabled={isRunning}
            title={isRunning ? "Wait for the current run to finish" : undefined}
            className="nodrag nopan w-full flex items-center gap-2 px-2.5 py-2 bg-neutral-900 border border-neutral-700 hover:border-neutral-500 rounded-md text-neutral-300 hover:text-neutral-100 disabled:text-neutral-600 disabled:hover:border-neutral-700 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <span className="text-xs font-medium">Cell nodes</span>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-400">
              {templateNodeCount} / cell
            </span>
          </button>

          {/* Preview with grid overlay */}
          <div className="relative flex-1 min-h-[96px] rounded-md overflow-hidden bg-neutral-900/40 border border-neutral-700/40">
            {nodeData.sourceImage ? (
              <>
                <img
                  src={adaptiveSourceImage ?? undefined}
                  alt="Source grid"
                  className="w-full h-full object-contain"
                />
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                    gridTemplateRows: `repeat(${gridRows}, 1fr)`,
                  }}
                >
                  {Array.from({ length: cellCount }).map((_, index) => (
                    <div key={index} className="border border-blue-400/50" />
                  ))}
                </div>
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                <svg className="w-5 h-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                </svg>
                <span className="text-neutral-500 text-[10px]">Connect image</span>
              </div>
            )}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
                <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
          </div>

          {/* Status + split */}
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[10px] truncate ${
                nodeData.status === "error"
                  ? "text-red-400"
                  : cellsAreStale && cells.length > 0
                    ? "text-amber-400"
                    : "text-neutral-500"
              }`}
              title={statusText}
            >
              {statusText}
            </span>
            <button
              onClick={handleSplit}
              disabled={isRunning || !nodeData.sourceImage}
              className="nodrag nopan shrink-0 px-2.5 py-1 text-[10px] border border-white hover:bg-white hover:text-neutral-900 disabled:border-neutral-600 disabled:text-neutral-600 disabled:cursor-not-allowed text-white rounded transition-colors"
              title={!nodeData.sourceImage ? "Connect an image first" : `Split into ${gridRows}×${gridCols}`}
            >
              Split {gridRows}×{gridCols}
            </button>
          </div>
        </div>
      </BaseNode>

      {/* Cell template editor */}
      {showEditor && (
        <SplitGridTemplateModal
          nodeId={id}
          nodeData={nodeData}
          onClose={() => setShowEditor(false)}
        />
      )}
    </>
  );
}
