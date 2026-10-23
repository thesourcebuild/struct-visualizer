"use client";

import { memberDeclarator, memberLabel, memberTypeLabel } from "@sp/core";
import type { CalculationResult } from "@sp/core";
import { Panel } from "@sp/ui";

const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

interface PaddingProcessProps {
  result: CalculationResult;
  explain: boolean;
}

/** Member-by-member walkthrough of how offsets and padding were derived. */
export function PaddingProcess({ result, explain }: PaddingProcessProps) {
  const memberPadding = result.members.reduce((sum, m) => sum + m.padding, 0);
  const trailing = result.totalPadding - memberPadding;
  const finalOffset = result.totalSize - trailing;
  const structAlign = result.struct.alignment ?? 1;
  // Bytes some member occupies; bit-fields can share a byte, so their sizes do not add up.
  const dataBytes = result.totalSize - result.totalPadding;
  // Rounding up to the struct's alignment explains the trailing padding, unless it also holds the
  // unused rest of an MSVC bit-field storage unit.
  const roundedTrailing = (structAlign - (finalOffset % structAlign)) % structAlign;

  return (
    <Panel
      title="Padding process, step by step"
      subtitle={explain ? "Explain mode: showing the equation for every member." : "Turn on Explain mode in Layout options to see the equations."}
      collapsible
      defaultCollapsed
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="font-semibold text-blue-900 dark:text-blue-100">Starting state</h4>
            <span className="font-mono text-sm text-blue-700 dark:text-blue-300">Offset: 0x00</span>
          </div>
          <p className="text-sm text-blue-800 dark:text-blue-200">
            Layout begins at byte 0. Members are placed sequentially with the padding each alignment needs.
          </p>
        </div>

        <ol className="space-y-3">
          {result.members.map((m, index) => {
            const currentOffset = m.offset - m.padding;
            const remainder = m.alignment > 0 ? currentOffset % m.alignment : 0;
            const nested = m.nested ?? null;
            const bits = m.member.bitField;
            const bitOffset = m.bitOffset;
            // What alignment alone would insert; more means an MSVC storage unit closed first.
            const alignPadding = m.alignment > 0 ? (m.alignment - remainder) % m.alignment : 0;

            return (
              <li
                key={index}
                className={`overflow-hidden rounded-lg border border-t-4 border-gray-300 dark:border-gray-600 ${m.padding > 0 ? "border-t-orange-500" : "border-t-gray-300 dark:border-t-gray-600"}`}
              >
                <div className="flex items-center justify-between border-b border-gray-300 bg-gray-50 px-4 py-3 dark:border-gray-600 dark:bg-gray-700">
                  <div className="flex items-center gap-3">
                    <span className={`h-4 w-4 shrink-0 rounded-full ${m.padding > 0 ? "bg-yellow-500" : "bg-green-500"}`} />
                    <div>
                      <h5 className="font-mono font-semibold text-gray-900 dark:text-gray-100">{memberDeclarator(m.member)}</h5>
                      <p className="text-xs text-gray-600 dark:text-gray-400">{memberTypeLabel(m.member)}</p>
                      {bits !== undefined && (
                        <p className="text-xs text-indigo-700 dark:text-indigo-300">
                          Bitfield: {bits} bit{bits === 1 ? "" : "s"}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {m.size} byte{m.size > 1 ? "s" : ""}
                    </p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">align: {m.alignment}</p>
                  </div>
                </div>

                <div className="space-y-2 px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {bitOffset !== undefined && bits !== undefined ? (
                    <>
                      {m.padding > 0 && (
                        <p>
                          <strong>Padding inserted:</strong> {m.padding} byte{m.padding > 1 ? "s" : ""} before this bit-field,
                          where the target&apos;s bit-field rules move it.
                        </p>
                      )}
                      <p>
                        <strong>Placed at</strong> bit{" "}
                        <code className="rounded bg-blue-100 px-2 py-0.5 font-mono dark:bg-blue-900">{bitOffset}</code>
                        {bits > 0 ? (
                          <>
                            {" "}(byte {hex(m.offset)}, bit {bitOffset % 8}), occupying bits {bitOffset}–{bitOffset + bits - 1}
                            {m.size > 1 && <> in bytes {hex(m.offset)}–{hex(m.offset + m.size - 1)}</>}.
                          </>
                        ) : (
                          <> (byte {hex(m.offset)}): a zero-width bit-field takes no space, it only moves what follows.</>
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                  {m.note && (
                    <p>
                      {m.padding > 0 && (
                        <>
                          <strong>Padding before it:</strong> {m.padding} byte{m.padding > 1 ? "s" : ""}.{" "}
                        </>
                      )}
                      {m.note}
                    </p>
                  )}
                  {!m.note && m.padding > 0 && m.padding !== alignPadding && (
                    <p>
                      <strong>Padding inserted:</strong> {m.padding} byte{m.padding > 1 ? "s" : ""} before this member: the
                      unused rest of the previous bit-fields&apos; storage unit, which MSVC&apos;s rules close before it
                      {alignPadding > 0 && <>, then alignment to a {m.alignment}-byte boundary</>}.
                    </p>
                  )}
                  {!m.note && m.padding > 0 && m.padding === alignPadding && (
                    <div>
                      <p>
                        <strong>Padding inserted:</strong> {m.padding} byte{m.padding > 1 ? "s" : ""} before this member,
                        to align <code className="rounded bg-gray-200 px-1 dark:bg-gray-700">{memberLabel(m.member)}</code> to a{" "}
                        {m.alignment}-byte boundary.
                      </p>
                      {explain && (
                        <div className="mt-2 space-y-1 font-mono text-xs">
                          <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">current_offset = {currentOffset}</p>
                          <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">padding = (A - (current_offset % A)) % A</p>
                          <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">
                            = ({m.alignment} - ({currentOffset} % {m.alignment})) % {m.alignment} = ({m.alignment} - {remainder}) % {m.alignment} = {m.padding}
                          </p>
                          <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">
                            member_offset = {currentOffset} + {m.padding} = {m.offset} ({hex(m.offset)})
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  {!m.note && explain && m.padding === 0 && !result.struct.isUnion && (
                    <p className="font-mono text-xs text-gray-600 dark:text-gray-400">
                      Already aligned: ({m.alignment} - ({currentOffset} % {m.alignment})) % {m.alignment} = 0
                    </p>
                  )}
                  <p>
                    <strong>Placed at</strong>{" "}
                    <code className="rounded bg-blue-100 px-2 py-0.5 font-mono dark:bg-blue-900">{hex(m.offset)}</code>
                    {m.size > 0 ? (
                      <>
                        , occupying {hex(m.offset)}–{hex(m.offset + m.size - 1)}.
                      </>
                    ) : (
                      <>, taking no space.</>
                    )}
                  </p>
                    </>
                  )}

                  {nested && (
                    <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-700 dark:bg-indigo-900/20">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                          Nested layout: {nested.struct.name}
                        </p>
                        <span className="font-mono text-xs text-indigo-700 dark:text-indigo-300">
                          size {nested.totalSize} · padding {nested.totalPadding}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                        {nested.members.map((nm, nidx) => (
                          <div
                            key={nidx}
                            className="flex items-center justify-between rounded border border-indigo-100 bg-white/70 px-2 py-1 dark:border-indigo-800 dark:bg-slate-800/40"
                          >
                            <span className="font-mono text-indigo-900 dark:text-indigo-100">{memberLabel(nm.member)}</span>
                            <span className={`font-mono ${nm.padding > 0 ? "text-orange-600 dark:text-orange-400" : "text-indigo-700 dark:text-indigo-300"}`}>
                              off {hex(nm.offset)} · sz {nm.size} · pad {nm.padding}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {trailing > 0 && (
          <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-700 dark:bg-yellow-900/20">
            <h5 className="mb-1 font-semibold text-yellow-900 dark:text-yellow-100">Trailing padding</h5>
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              {trailing === roundedTrailing ? (
                <>
                  {trailing} byte{trailing > 1 ? "s" : ""} added at the end so the size is a multiple of the{" "}
                  {structAlign}-byte struct alignment.
                </>
              ) : (
                <>
                  {trailing} byte{trailing > 1 ? "s" : ""} at the end: the unused rest of the last bit-fields&apos; storage
                  unit, which MSVC&apos;s rules keep, then rounding up to the {structAlign}-byte struct alignment.
                </>
              )}
            </p>
            {explain && trailing === roundedTrailing && (
              <div className="mt-2 space-y-1 font-mono text-xs text-yellow-900 dark:text-yellow-100">
                <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">tail_padding = (A - (final_offset % A)) % A</p>
                <p className="rounded bg-yellow-100 px-2 py-1 dark:bg-yellow-900/30">
                  = ({structAlign} - ({finalOffset} % {structAlign})) % {structAlign} = {trailing}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
          <h4 className="mb-3 font-semibold text-green-900 dark:text-green-100">Summary</h4>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              ["Total size", `${result.totalSize}`, "text-green-700 dark:text-green-400"],
              ["Total padding", `${result.totalPadding}`, "text-orange-600 dark:text-orange-400"],
              ["Alignment", `${structAlign}`, "text-blue-700 dark:text-blue-400"],
              ["Data / size", `${((dataBytes / Math.max(result.totalSize, 1)) * 100).toFixed(0)}%`, "text-purple-700 dark:text-purple-400"],
            ].map(([label, value, color]) => (
              <div key={label}>
                <dt className="mb-1 text-xs font-medium text-green-700 dark:text-green-300">{label}</dt>
                <dd className={`text-2xl font-bold ${color}`}>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Panel>
  );
}
