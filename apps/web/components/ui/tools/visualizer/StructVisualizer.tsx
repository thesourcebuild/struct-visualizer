'use client';

import React, { useState } from 'react';
import { memberDeclarator, memberLabel, memberTypeLabel } from '@sp/core';
import type { CalculationResult } from '@sp/core';

export type TabOption = 'all' | 'visualization' | 'statistics' | 'details';

interface StructVisualizerProps {
  result: CalculationResult;
  hideDropdown?: boolean;
  activeTab?: TabOption;
  onTabChange?: (tab: TabOption) => void;
  sectionMinHeights?: Partial<Record<'visualization' | 'statistics' | 'details', number>>;
}

/** Square collapse/expand button shared by the three sections. */
function SectionToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? 'Collapse' : 'Expand'}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
    >
      <svg
        viewBox="0 0 24 24"
        className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      <span className="sr-only">{expanded ? 'Collapse section' : 'Expand section'}</span>
    </button>
  );
}

export default function StructVisualizer({ result, hideDropdown = false, activeTab: controlledTab, onTabChange, sectionMinHeights }: StructVisualizerProps) {
  const [internalTab, setInternalTab] = useState<TabOption>('all');
  const activeTab = controlledTab !== undefined ? controlledTab : internalTab;

  const setActiveTab = (tab: TabOption) => {
    if (onTabChange) {
      onTabChange(tab);
    } else {
      setInternalTab(tab);
    }
  };

  // Section collapse states
  const [expandedSections, setExpandedSections] = useState({
    visualization: true,
    statistics: true,
    details: true,
  });

  const toggleSection = (section: 'visualization' | 'statistics' | 'details') => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };
  const BYTE_WIDTH = 40;
  const BYTE_HEIGHT = 30;

  // Calculate grid layout
  const bytesPerRow = 16;

  const getColorForMember = (index: number): string => {
    const colors = [
      'bg-blue-500',
      'bg-green-500',
      'bg-purple-500',
      'bg-orange-500',
      'bg-pink-500',
      'bg-cyan-500',
      'bg-yellow-500',
      'bg-red-500',
      'bg-indigo-500',
      'bg-teal-500',
    ];
    return colors[index % colors.length];
  };

  const renderBytesForResult = (layout: CalculationResult) => {
    const bytes: React.ReactElement[] = [];
    let currentByte = 0;

    for (let memberIndex = 0; memberIndex < layout.members.length; memberIndex++) {
      const { member, offset, size, padding } = layout.members[memberIndex];
      const color = getColorForMember(memberIndex);

      // Render padding before member
      for (let i = 0; i < padding; i++) {
        bytes.push(
          <div
            key={`padding-${currentByte}`}
            className="relative border border-gray-300 bg-gray-200 dark:bg-gray-700"
            style={{ width: BYTE_WIDTH, height: BYTE_HEIGHT }}
            title={`Padding byte at offset ${currentByte}`}
          >
            <div className="flex items-center justify-center h-full text-xs text-gray-500">
              ·
            </div>
          </div>
        );
        currentByte++;
      }

      // Render member bytes
      for (let i = 0; i < size; i++) {
        const isFirst = i === 0;
        const isLast = i === size - 1;

        bytes.push(
          <div
            key={`member-${memberIndex}-${i}`}
            className={`relative border border-gray-300 ${color} ${isFirst ? 'rounded-l' : ''
              } ${isLast ? 'rounded-r' : ''}`}
            style={{ width: BYTE_WIDTH, height: BYTE_HEIGHT }}
            title={`${memberLabel(member)} (${memberTypeLabel(member)})\nOffset: ${offset + i}\nByte ${i + 1}/${size}`}
          >
            {isFirst && (
              <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white truncate px-1">
                {/* Skip punctuation, so "(discriminant)" reads "d". */}
                {member.name.replace(/^[^A-Za-z0-9_]+/, '').charAt(0)}
              </div>
            )}
          </div>
        );
        currentByte++;
      }
    }

    // Render trailing padding
    while (currentByte < layout.totalSize) {
      bytes.push(
        <div
          key={`trailing-${currentByte}`}
          className="relative border border-gray-300 bg-gray-200 dark:bg-gray-700"
          style={{ width: BYTE_WIDTH, height: BYTE_HEIGHT }}
          title={`Trailing padding at offset ${currentByte}`}
        >
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            ·
          </div>
        </div>
      );
      currentByte++;
    }

    return bytes;
  };

  const renderBytes = () => renderBytesForResult(result);

  // The engine that produced the result also laid out each nested record, in the same mode.
  const getNestedLayout = (memberLayout: CalculationResult['members'][number]) => memberLayout.nested ?? null;

  const buildFlatLayoutResult = (memberLayout: CalculationResult['members'][number]): CalculationResult => {
    const size = memberLayout.size;
    return {
      struct: {
        name: memberLayout.member.name,
        members: [memberLayout.member],
        totalSize: size,
        alignment: memberLayout.alignment,
        totalPadding: 0,
      },
      members: [{
        member: memberLayout.member,
        offset: 0,
        size,
        padding: 0,
        alignment: memberLayout.alignment,
      }],
      totalSize: size,
      totalPadding: 0,
      wastedSpace: 0,
      efficiency: 100,
      architecture: result.architecture,
    };
  };

  const tabOptions: { value: TabOption; label: string }[] = [
    { value: 'all', label: 'Details (All Sections)' },
    { value: 'visualization', label: 'Memory Visualization' },
    { value: 'statistics', label: 'Statistics' },
    { value: 'details', label: 'Member Details' },
  ];

  return (
    <div className="space-y-6">
      {/* Dropdown Menu */}
      {!hideDropdown && (
        <div className="flex items-center gap-3">
          <label htmlFor="details-select" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            View:
          </label>
          <select
            id="details-select"
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as TabOption)}
            className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm font-medium hover:border-gray-400 dark:hover:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 transition-colors"
          >
            {tabOptions.map((tab) => (
              <option key={tab.value} value={tab.value}>
                {tab.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Content Container */}
      <div className="space-y-6">
        {/* Visual Memory Layout */}
        {(activeTab === 'all' || activeTab === 'visualization') && (
          <div
            data-section="visualization"
            className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700"
            style={sectionMinHeights?.visualization ? { minHeight: sectionMinHeights.visualization } : undefined}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Memory Layout Visualization
                </h3>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  0x{(0).toString(16).padStart(2, '0')} - 0x{(result.totalSize - 1).toString(16).padStart(2, '0')}
                </span>
              </div>
              <SectionToggle expanded={expandedSections.visualization} onToggle={() => toggleSection('visualization')} />
            </div>

            {expandedSections.visualization && (
              <div>
                {result.struct.isUnion ? (
                  <div className="space-y-4 mb-6">
                    {(() => {
                      const unionLayouts = result.members.map((memberLayout) => {
                        const nestedLayout = getNestedLayout(memberLayout);
                        return {
                          memberLayout,
                          layout: nestedLayout ?? buildFlatLayoutResult(memberLayout),
                        };
                      });

                      const isEnum = result.struct.isEnum === true;
                      const largestMember = unionLayouts.reduce((max, current) =>
                        current.memberLayout.size > max.memberLayout.size ? current : max
                      );
                      const largestIndex = unionLayouts.findIndex(item => item === largestMember);

                      return (
                        <>
                          <div className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                  {isEnum ? 'Variants' : 'Combined Union Memory Map'}
                                </span>
                              </div>
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {unionLayouts.length} {isEnum ? 'variants' : 'members'} · overlapping from 0x00
                              </span>
                            </div>
                            <div className="space-y-2">
                              {unionLayouts.map((item, idx) => (
                                <div key={`combined-${idx}`} className="flex items-center gap-3">
                                  <div className="flex items-center gap-2 min-w-[120px]">
                                    <span className={`w-2.5 h-2.5 rounded-full ${getColorForMember(idx)}`} />
                                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200">
                                      {memberLabel(item.memberLayout.member)}
                                    </span>
                                  </div>
                                  <div className="overflow-x-auto">
                                    <div
                                      className="inline-grid gap-0"
                                      style={{
                                        gridTemplateColumns: `repeat(${bytesPerRow}, ${BYTE_WIDTH}px)`,
                                      }}
                                    >
                                      {renderBytesForResult(item.layout)}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/20 p-3">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`w-2.5 h-2.5 rounded-full ${getColorForMember(largestIndex)}`} />
                                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                  {isEnum ? 'Largest Variant' : 'Largest Union Member'}
                                </span>
                                <span className="text-xs text-gray-500 dark:text-gray-400">({memberLabel(largestMember.memberLayout.member)})</span>
                              </div>
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                size {largestMember.memberLayout.size} · padding {largestMember.layout.totalPadding}
                              </span>
                            </div>
                            <div className="overflow-x-auto">
                              <div
                                className="inline-grid gap-0"
                                style={{
                                  gridTemplateColumns: `repeat(${bytesPerRow}, ${BYTE_WIDTH}px)`,
                                }}
                              >
                                {renderBytesForResult(largestMember.layout)}
                              </div>
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="overflow-x-auto mb-6">
                    <div
                      className="inline-grid gap-0"
                      style={{
                        gridTemplateColumns: `repeat(${bytesPerRow}, ${BYTE_WIDTH}px)`,
                      }}
                    >
                      {renderBytes()}
                    </div>
                  </div>
                )}

                {/* Byte offset labels */}
                {/* Legend - Only for non-union structs */}
                {!result.struct.isUnion && (
                  <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                    <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-gray-100">Legend</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                      {result.members.map((m, index) => (
                        <div key={index} className="flex items-start gap-2 p-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                          <div
                            className={`w-6 h-6 rounded flex-shrink-0 mt-0.5 border border-gray-300 ${getColorForMember(index)}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                              {memberLabel(m.member)}
                            </div>
                            <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 break-words">
                              {memberTypeLabel(m.member)} • {m.size}b
                              {m.padding > 0 && ` +${m.padding}p`} • 0x{m.offset.toString(16).padStart(2, '0')}
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex items-start gap-2 p-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <div className="w-6 h-6 rounded flex-shrink-0 mt-0.5 border border-gray-300 bg-gray-200 dark:bg-gray-600" />
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Padding</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Statistics Card */}
        {(activeTab === 'all' || activeTab === 'statistics') && (
          <div
            data-section="statistics"
            className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700"
            style={sectionMinHeights?.statistics ? { minHeight: sectionMinHeights.statistics } : undefined}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Statistics
              </h3>
              <SectionToggle expanded={expandedSections.statistics} onToggle={() => toggleSection('statistics')} />
            </div>
            {expandedSections.statistics && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-900/40 p-4 border border-blue-200 dark:border-blue-800/50">
                  <div className="relative z-10">
                    <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                      {result.totalSize}
                    </div>
                    <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mt-2">
                      Total Size
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">bytes</div>
                  </div>
                  <div className="absolute top-0 right-0 w-12 h-12 bg-blue-200 dark:bg-blue-800/30 rounded-full -mr-4 -mt-4 opacity-20"></div>
                </div>

                <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-900/40 p-4 border border-red-200 dark:border-red-800/50">
                  <div className="relative z-10">
                    <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                      {result.totalPadding}
                    </div>
                    <div className="text-xs font-medium text-red-700 dark:text-red-300 mt-2">
                      Padding
                    </div>
                    <div className="text-xs text-red-600 dark:text-red-400 mt-1">wasted</div>
                  </div>
                  <div className="absolute top-0 right-0 w-12 h-12 bg-red-200 dark:bg-red-800/30 rounded-full -mr-4 -mt-4 opacity-20"></div>
                </div>

                <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-900/40 p-4 border border-green-200 dark:border-green-800/50">
                  <div className="relative z-10">
                    <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                      {result.efficiency.toFixed(1)}%
                    </div>
                    <div className="text-xs font-medium text-green-700 dark:text-green-300 mt-2">
                      Efficiency
                    </div>
                    <div className="text-xs text-green-600 dark:text-green-400 mt-1">density</div>
                  </div>
                  <div className="absolute top-0 right-0 w-12 h-12 bg-green-200 dark:bg-green-800/30 rounded-full -mr-4 -mt-4 opacity-20"></div>
                </div>

                <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-900/40 p-4 border border-purple-200 dark:border-purple-800/50">
                  <div className="relative z-10">
                    <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                      {result.struct.alignment || 'N/A'}
                    </div>
                    <div className="text-xs font-medium text-purple-700 dark:text-purple-300 mt-2">
                      Alignment
                    </div>
                    <div className="text-xs text-purple-600 dark:text-purple-400 mt-1">bytes</div>
                  </div>
                  <div className="absolute top-0 right-0 w-12 h-12 bg-purple-200 dark:bg-purple-800/30 rounded-full -mr-4 -mt-4 opacity-20"></div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Detailed Member Info */}
        {(activeTab === 'all' || activeTab === 'details') && (
          <div
            data-section="details"
            className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700"
            style={sectionMinHeights?.details ? { minHeight: sectionMinHeights.details } : undefined}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Member Details
              </h3>
              <SectionToggle expanded={expandedSections.details} onToggle={() => toggleSection('details')} />
            </div>
            {expandedSections.details && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left py-3 px-4 font-semibold text-gray-700 dark:text-gray-300 first:rounded-tl-lg">
                        Member
                      </th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700 dark:text-gray-300">
                        Type
                      </th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700 dark:text-gray-300">
                        Offset
                      </th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700 dark:text-gray-300">
                        Size
                      </th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700 dark:text-gray-300">
                        Align
                      </th>
                      <th className="text-center py-3 px-4 font-semibold text-gray-700 dark:text-gray-300 last:rounded-tr-lg">
                        Padding
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.members.map((m, index) => (
                      <tr
                        key={index}
                        className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50/50 dark:hover:bg-gray-700/30 transition-colors"
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-3 h-3 rounded-full flex-shrink-0 ${getColorForMember(index)}`}
                            />
                            <span className="font-mono font-medium text-gray-900 dark:text-gray-100">
                              {memberDeclarator(m.member)}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono text-gray-700 dark:text-gray-300 text-xs">
                          {memberTypeLabel(m.member)}
                        </td>
                        <td className="py-3 px-4 text-center font-mono text-gray-700 dark:text-gray-300 text-sm">
                          0x{m.offset.toString(16).padStart(2, '0')}
                        </td>
                        <td className="py-3 px-4 text-center font-mono font-medium text-gray-900 dark:text-gray-100">
                          {m.size}
                        </td>
                        <td className="py-3 px-4 text-center font-mono text-gray-700 dark:text-gray-300">
                          {m.alignment}
                        </td>
                        <td className={`py-3 px-4 text-center font-mono font-medium ${m.padding > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-500'}`}>
                          {m.padding > 0 ? m.padding : '—'}
                        </td>
                      </tr>
                    ))}
                    {/* Trailing padding row */}
                    {result.totalPadding > result.members.reduce((sum, m) => sum + m.padding, 0) && (
                      <tr className="bg-yellow-50 dark:bg-yellow-900/10 border-b border-gray-200 dark:border-gray-700">
                        <td className="py-3 px-4 italic text-gray-700 dark:text-gray-400 font-medium" colSpan={5}>
                          ↳ Trailing padding
                        </td>
                        <td className="py-3 px-4 text-center font-mono font-medium text-yellow-600 dark:text-yellow-400">
                          {result.totalPadding -
                            result.members.reduce((sum, m) => sum + m.padding, 0)}
                        </td>
                      </tr>
                    )}
                    {/* Totals row - separated with thick border */}
                    {!result.struct.isUnion ? (
                      <>
                        <tr className="bg-gradient-to-r from-blue-100 to-blue-50 dark:from-blue-900/40 dark:to-blue-900/20 border-t-4 border-blue-500 dark:border-blue-600 font-bold">
                          <td className="py-2 px-4 text-gray-900 dark:text-gray-100" colSpan={3}>
                            TOTAL
                          </td>
                          <td className="py-2 px-4 text-center font-mono text-lg text-blue-700 dark:text-blue-300">
                            {result.members.reduce((sum, m) => sum + m.size, 0)}
                          </td>
                          <td className="py-2 px-4 text-center" />
                          <td className="py-2 px-4 text-center font-mono text-lg text-blue-700 dark:text-blue-300">
                            {result.totalPadding}
                          </td>
                        </tr>
                        <tr className="bg-blue-100/60 dark:bg-blue-900/30 font-bold">
                          <td className="py-2 px-4 text-gray-900 dark:text-gray-100" colSpan={4}>
                            Overall Total (Size + Padding)
                          </td>
                          <td className="py-2 px-4 text-center" />
                          <td className="py-2 px-4 text-center font-mono text-lg text-green-700 dark:text-green-300">
                            {result.totalSize}
                          </td>
                        </tr>
                      </>
                    ) : (
                      <tr className="bg-gradient-to-r from-indigo-100 to-indigo-50 dark:from-indigo-900/40 dark:to-indigo-900/20 border-t-4 border-indigo-500 dark:border-indigo-600 font-bold">
                        <td className="py-2 px-4 text-gray-900 dark:text-gray-100" colSpan={3}>
                          {result.struct.isEnum ? 'Enum Total (Largest Variant)' : 'Union Total (Largest Member)'}
                        </td>
                        <td className="py-2 px-4 text-center font-mono text-lg text-indigo-700 dark:text-indigo-300">
                          {Math.max(...result.members.map(m => m.size))}
                        </td>
                        <td className="py-2 px-4 text-center" />
                        <td className="py-2 px-4 text-center font-mono text-lg text-indigo-700 dark:text-indigo-300">
                          {result.totalPadding}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
