import { memberLabel } from '@sp/core';
import type { CalculationResult } from '@sp/core';

export type JsonExportInput = {
  displayResult: CalculationResult;
  code: string;
  /** Source language: 'c', 'cpp', 'go', 'rust'. */
  language: string;
  /** What the layout was computed for, e.g. { targetArchitecture, dataModel, osType }. */
  platform: Record<string, string>;
  /** Which layout is shown: natural, packed or optimized. */
  view: string;
};

export type PngExportInput = {
  displayResult: CalculationResult;
  /** One line under the title naming the platform, e.g. "Architecture: x86-64   OS: Linux". */
  subtitle: string;
};

const downloadTextFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const exportResultAsJsonFile = (input: JsonExportInput) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    input: {
      code: input.code,
      language: input.language,
      ...input.platform,
      view: input.view,
    },
    result: input.displayResult,
  };
  downloadTextFile(
    JSON.stringify(payload, null, 2),
    `${input.displayResult.struct.name || 'layout'}_layout.json`,
    'application/json'
  );
};

export const exportResultAsPngFile = (input: PngExportInput) => {
  const { displayResult, subtitle } = input;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scale = 2;
  const width = 1980;
  const margin = 72;
  const contentW = width - (margin * 2);
  const bytesPerRow = 16;
  const cellSize = 52;
  const rowGap = 6;
  const colGap = 4;
  const gridLabelW = 90;
  const gridGap = 34;
  const rowHeight = cellSize + rowGap;
  const bytesRows = Math.max(1, Math.ceil(Math.max(displayResult.totalSize, 1) / bytesPerRow));
  const gridH = bytesRows * rowHeight;
  const membersLegendH = Math.max(gridH, 44 + (displayResult.members.length * 44));
  const gridTopOffset = 52;
  const gridContentH = gridTopOffset + Math.max(gridH, membersLegendH);
  const headerH = 180;
  const statsCardH = 132;
  const legendH = 112;
  const sectionGap = 24;
  const footerPad = 28;
  const height = margin + headerH + sectionGap + statsCardH + sectionGap + legendH + sectionGap + gridContentH + footerPad;

  const pageBg = '#f3f4f6';
  const panelBg = '#ffffff';
  const border = '#d1d5db';
  const text = '#111827';
  const muted = '#4b5563';
  const blue = '#2563eb';
  const red = '#dc2626';
  const purple = '#9333ea';
  const green = '#16a34a';

  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(scale, scale);

  ctx.fillStyle = pageBg;
  ctx.fillRect(0, 0, width, height);

  const drawPanel = (x: number, y: number, w: number, h: number, bg = panelBg) => {
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  };

  const memberSwatches = ['#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ec4899', '#06b6d4', '#eab308', '#ef4444', '#6366f1', '#14b8a6'];
  const memberColor = (idx: number): string => memberSwatches[idx % memberSwatches.length];
  const memberPaddingTotal = displayResult.members.reduce((sum, m) => sum + m.padding, 0);
  const trailingPadding = Math.max(0, displayResult.totalPadding - memberPaddingTotal);
  const trailingStart = Math.max(0, displayResult.totalSize - trailingPadding);
  const byteCells: Array<{ kind: 'data' | 'padding' | 'trailing'; memberIndex: number }> = new Array(displayResult.totalSize)
    .fill(null)
    .map(() => ({ kind: 'padding', memberIndex: -1 }));

  for (let i = trailingStart; i < displayResult.totalSize; i += 1) {
    byteCells[i] = { kind: 'trailing', memberIndex: -1 };
  }
  displayResult.members.forEach((m, index) => {
    for (let i = 0; i < m.padding; i += 1) {
      const idx = (m.offset - m.padding) + i;
      if (idx >= 0 && idx < byteCells.length) byteCells[idx] = { kind: 'padding', memberIndex: -1 };
    }
    for (let i = 0; i < m.size; i += 1) {
      const idx = m.offset + i;
      if (idx >= 0 && idx < byteCells.length) byteCells[idx] = { kind: 'data', memberIndex: index };
    }
  });

  // Header
  let y = margin;
  ctx.fillStyle = text;
  ctx.font = '700 56px Segoe UI, Arial, sans-serif';
  ctx.fillText(displayResult.struct.name || 'Struct Example', margin, y + 58);
  ctx.fillStyle = muted;
  ctx.font = '600 26px Segoe UI, Arial, sans-serif';
  ctx.fillText(subtitle, margin, y + 106);

  // Stats cards
  y += headerH + sectionGap;
  const cardGap = 24;
  const cardW = Math.floor((contentW - (cardGap * 3)) / 4);
  const stats = [
    { label: 'Total Size', value: `${displayResult.totalSize} B`, valueColor: blue, bg: '#eff6ff', borderColor: '#bfdbfe' },
    { label: 'Padding', value: `${displayResult.totalPadding} B`, valueColor: red, bg: '#fef2f2', borderColor: '#fecaca' },
    { label: 'Alignment', value: `${displayResult.struct.alignment} B`, valueColor: purple, bg: '#faf5ff', borderColor: '#e9d5ff' },
    { label: 'Members', value: `${displayResult.members.length}`, valueColor: green, bg: '#f0fdf4', borderColor: '#bbf7d0' },
  ];

  stats.forEach((s, idx) => {
    const x = margin + (idx * (cardW + cardGap));
    drawPanel(x, y, cardW, statsCardH, s.bg);
    ctx.strokeStyle = s.borderColor;
    ctx.strokeRect(x, y, cardW, statsCardH);
    ctx.fillStyle = '#6b7280';
    ctx.font = '600 18px Segoe UI, Arial, sans-serif';
    ctx.fillText(s.label, x + 24, y + 44);
    ctx.fillStyle = s.valueColor;
    ctx.font = '700 42px Segoe UI, Arial, sans-serif';
    ctx.fillText(s.value, x + 24, y + 88);
  });

  // Legend panel
  y += statsCardH + sectionGap;
  drawPanel(margin, y, contentW, legendH);
  ctx.fillStyle = muted;
  ctx.font = '700 24px Segoe UI, Arial, sans-serif';
  ctx.fillText('Legend', margin + 24, y + 40);

  const legendDefs = [
    { name: 'Padding', color: '#d1d5db', borderColor: '#9ca3af' },
    { name: 'Trailing padding', color: '#e5e7eb', borderColor: '#9ca3af' },
  ];
  let legendX = margin + 24;
  legendDefs.forEach((item) => {
    const boxY = y + 58;
    ctx.fillStyle = item.color;
    ctx.fillRect(legendX, boxY, 34, 34);
    ctx.strokeStyle = item.borderColor;
    ctx.strokeRect(legendX, boxY, 34, 34);
    ctx.fillStyle = muted;
    ctx.font = '600 18px Segoe UI, Arial, sans-serif';
    ctx.fillText(item.name, legendX + 52, boxY + 29);
    legendX += 300;
  });

  // Grid and members legend
  y += legendH + sectionGap;
  const gridX = margin + gridLabelW;
  const gridY = y + gridTopOffset;
  const gridW = (cellSize * bytesPerRow) + (colGap * (bytesPerRow - 1));
  const memberX = gridX + gridW + gridGap;

  ctx.fillStyle = muted;
  ctx.font = '600 22px Segoe UI, Arial, sans-serif';
  for (let c = 0; c < bytesPerRow; c += 1) {
    const label = c.toString(16).toUpperCase();
    const x = gridX + (c * (cellSize + colGap)) + (cellSize / 2) - 7;
    ctx.fillText(label, x, y + 32);
  }

  for (let r = 0; r < bytesRows; r += 1) {
    const rowBase = r * bytesPerRow;
    const rowY = gridY + (r * rowHeight);
    ctx.fillStyle = muted;
    ctx.font = '700 24px Consolas, "Courier New", monospace';
    ctx.fillText(`0x${rowBase.toString(16).padStart(4, '0')}`, margin, rowY + 38);

    for (let c = 0; c < bytesPerRow; c += 1) {
      const idx = rowBase + c;
      if (idx >= displayResult.totalSize) continue;

      const x = gridX + (c * (cellSize + colGap));
      const cell = byteCells[idx];
      let fill = '#d1d5db';
      let stroke = '#9ca3af';
      if (cell.kind === 'data') {
        fill = memberColor(cell.memberIndex);
        stroke = '#64748b';
      } else if (cell.kind === 'trailing') {
        fill = '#e5e7eb';
        stroke = '#9ca3af';
      }

      ctx.fillStyle = fill;
      ctx.fillRect(x, rowY, cellSize, cellSize);
      ctx.strokeStyle = stroke;
      ctx.strokeRect(x, rowY, cellSize, cellSize);
      ctx.fillStyle = '#1f2937';
      ctx.font = '700 17px Consolas, "Courier New", monospace';
      ctx.fillText(idx.toString(16).toUpperCase().padStart(2, '0'), x + 13, rowY + 31);
    }
  }

  ctx.fillStyle = muted;
  ctx.font = '700 26px Segoe UI, Arial, sans-serif';
  ctx.fillText('Members', memberX, y + 38);
  displayResult.members.forEach((m, idx) => {
    const my = y + 58 + (idx * 44);
    ctx.fillStyle = memberColor(idx);
    ctx.fillRect(memberX, my, 30, 30);
    ctx.strokeStyle = '#64748b';
    ctx.strokeRect(memberX, my, 30, 30);
    ctx.fillStyle = '#111827';
    ctx.font = '700 22px Segoe UI, Arial, sans-serif';
    ctx.fillText(memberLabel(m.member), memberX + 44, my + 26);
  });

  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${displayResult.struct.name || 'layout'}_layout.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};
