/**
 * The padding-rules guide body. Shared by the /padding-rules/ page and the in-app guide
 * overlay, so the two can never drift apart.
 */
export function PaddingRulesGuide() {
  return (
    <div className="space-y-8">
      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Alignment Rules</h2>
        <ul className="space-y-2 text-gray-700 dark:text-gray-300 list-disc pl-5">
          <li>Each member is placed at an offset that satisfies its ABI/compiler-defined alignment requirement.</li>
          <li>Alignment is often equal to size for common primitives, but not always.</li>
          <li>Every valid alignment is a power of two (1, 2, 4, 8, 16, ...), as required by the C and C++ standards.</li>
          <li><code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">char</code> is always 1-byte aligned.</li>
          <li><code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">short</code> is typically 2-byte aligned on 32- and 64-bit targets.</li>
          <li><code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">int/float</code> are typically 4-byte aligned on 32- and 64-bit targets.</li>
          <li>
            <code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">double</code> and{' '}
            <code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">long long</code> are 8-byte aligned on x86-64, AArch64,
            ARM32 (AAPCS) and 32-bit Windows (MSVC), but only 4-byte aligned inside structs under the 32-bit x86 System V ABI (Linux i386).
          </li>
          <li>
            <code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">pointers (including void*)</code> are 8 bytes on 64-bit
            targets, 4 bytes on 32-bit targets, and 2 bytes on 8/16-bit microcontrollers such as AVR.
          </li>
          <li>
            On 8-bit AVR (avr-gcc) <strong>every</strong> type is 1-byte aligned and <code className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded text-sm">int</code> is
            2 bytes, so structs there get no padding at all.
          </li>
        </ul>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Padding Rules</h2>
        <ul className="space-y-2 text-gray-700 dark:text-gray-300 list-disc pl-5">
          <li>Padding can be inserted before a member when needed to satisfy alignment.</li>
          <li>Trailing padding makes total struct size a multiple of the struct alignment.</li>
          <li>Struct alignment is usually the maximum required alignment among members (subject to packing rules).</li>
          <li>Unions place members at offset 0 and size is at least the largest member, rounded for required alignment.</li>
          <li>Nested structs are aligned as members in the parent; their internal layout follows their own rules.</li>
        </ul>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Architecture Impact</h2>
        <ul className="space-y-2 text-gray-700 dark:text-gray-300 list-disc pl-5">
          <li><strong>x86-64:</strong> 8-byte pointers; 64-bit scalars are 8-byte aligned on both Linux (System V) and Windows. <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">long double</code> differs: 16 bytes on Linux, 8 bytes (same as double) on Windows.</li>
          <li><strong>x86 (32-bit):</strong> 4-byte pointers. Linux (System V i386) aligns double/long long to 4 inside structs; MSVC aligns them to 8, so the same struct can have different sizes on the two.</li>
          <li><strong>ARM:</strong> ARM32 under the AAPCS (the modern EABI) aligns double/long long to 8; the obsolete APCS aligned them to 4. AArch64 uses 8-byte pointers and natural alignment.</li>
          <li><strong>Embedded:</strong> on 8-bit AVR the ABI itself aligns everything to 1 byte, so there is no padding. On other microcontrollers, packed layouts are usually requested explicitly with toolchain-specific pragmas or attributes.</li>
        </ul>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Intuition for Padding Algorithm</h2>
        <div className="space-y-4 text-gray-700 dark:text-gray-300">
          <p>For standard members (no special packing directives/attributes and bit-fields):</p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Quick Mental Shortcut</h3>
          <p className="italic text-sm">
            <strong>Padding = &quot;how many bytes until the next multiple of alignment&quot;</strong>
          </p>
        </div>

        <div>
          <p className="mb-3">Let:</p>
          <ul className="space-y-1 text-sm ml-4 mb-3">
            <li><code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">offset</code> = current byte offset in the struct</li>
            <li><code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">A</code> = alignment requirement of the next member</li>
            <li><code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">S</code> = size of the next member</li>
          </ul>
          <p className="text-sm font-semibold mb-2">Padding before a member:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-3">
            padding = (A - (offset % A)) % A
          </div>
          <p className="text-sm font-semibold mb-2">New offset after adding the member:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-3">
            offset = offset + padding + S
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Final Struct Size (Tail Padding)</h3>
          <p className="text-sm mb-2">After all members, calculate tail padding:</p>
          <p className="text-sm mb-3">Let <code className="bg-blue-100 dark:bg-blue-900 px-1 py-0.5 rounded">struct_align</code> = max alignment of all members</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-3">
            <div>final_offset = offset</div>
            tail_padding = (struct_align - (final_offset % struct_align)) % struct_align
          </div>
          <p className="text-sm font-semibold">Total struct size:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-3">
            struct_size = final_offset + tail_padding
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Alignment Helper (Common Macro Form)</h3>
          <p className="text-sm mb-2">If Alignment is a power of 2 (which it always is for standard types). This classic formula can be used to align an offset to a boundary:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-2">
            aligned_offset = (offset + A - 1) &amp; ~(A - 1)
          </div>
          <p className="text-sm">Which is equivalent to:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-sm mb-3">
            aligned_offset = ceil(offset / A) * A
          </div>
        </div>

        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Algorithm (Language-Agnostic)</h3>
          <p className="text-sm mb-3">This is the pseudocode being followed:</p>
          <div className="bg-gray-100 dark:bg-gray-700 p-4 rounded font-mono text-sm space-y-1 overflow-x-auto">
            <div>offset = 0</div>
            <div>struct_align = 1</div>
            <div></div>
            <div><span className="text-blue-600 dark:text-blue-400">for each</span> member:</div>
            <div className="ml-4">A = alignof(member)</div>
            <div className="ml-4">S = sizeof(member)</div>
            <div></div>
            <div className="ml-4">padding = (A - (offset % A)) % A</div>
            <div className="ml-4">offset += padding + S</div>
            <div className="ml-4">struct_align = max(struct_align, A)</div>
            <div></div>
            <div>struct_size = offset + (struct_align - (offset % struct_align)) % struct_align</div>
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">
          Guided Example: The &quot;Example&quot; Struct
        </h2>
        <div className="space-y-4 text-gray-700 dark:text-gray-300">
          <p>This walkthrough shows how internal and trailing padding accumulate under a typical x86-64 ABI.</p>

          <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 font-mono text-sm space-y-1">
            <div><span className="text-purple-600 dark:text-purple-400">struct</span> Example {'{'}</div>
            <div className="ml-4">char        c1;     <span className="text-gray-500">{'// 1 byte'}</span></div>
            <div className="ml-4">int32_t     i;      <span className="text-gray-500">{'// 4 bytes'}</span></div>
            <div className="ml-4">char        c2;     <span className="text-gray-500">{'// 1 byte'}</span></div>
            <div className="ml-4">double      d;      <span className="text-gray-500">{'// 8 bytes'}</span></div>
            <div className="ml-4">int16_t     s;      <span className="text-gray-500">{'// 2 bytes'}</span></div>
            <div className="ml-4">void*       p;      <span className="text-gray-500">{'// 8 bytes'}</span></div>
            <div>{'};'}</div>
          </div>

          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Assumptions (common x86-64 ABI)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-100 dark:bg-gray-700">
                    <th className="border border-gray-300 dark:border-gray-600 px-3 py-2 text-left font-semibold">Type</th>
                    <th className="border border-gray-300 dark:border-gray-600 px-3 py-2 text-left font-semibold">Size</th>
                    <th className="border border-gray-300 dark:border-gray-600 px-3 py-2 text-left font-semibold">Alignment</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">char</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">1</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">1</td></tr>
                  <tr><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">int32_t</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">4</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">4</td></tr>
                  <tr><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">double</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">8</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">8</td></tr>
                  <tr><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">int16_t</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">2</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">2</td></tr>
                  <tr><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">void*</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">8</td><td className="border border-gray-300 dark:border-gray-600 px-3 py-2 font-mono text-xs">8</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3">
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">Start</div>
              <div>offset = 0</div>
              <div>struct_align = 1</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">char c1</div>
              <div>A = 1, pad = (1 - (0 % 1)) % 1 = 0</div>
              <div>offset = 0 + 0 + 1 = 1, struct_align = max(1, 1) = 1</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">int32_t i</div>
              <div>A = 4, pad = (4 - (1 % 4)) % 4 = 3</div>
              <div>offset = 1 + 3 + 4 = 8, struct_align = max(1, 4) = 4</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">char c2</div>
              <div>A = 1, pad = 0</div>
              <div>offset = 8 + 0 + 1 = 9, struct_align = 4</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">double d</div>
              <div>A = 8, pad = (8 - (9 % 8)) % 8 = 7</div>
              <div>offset = 9 + 7 + 8 = 24, struct_align = max(4, 8) = 8</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">int16_t s</div>
              <div>A = 2, pad = (2 - (24 % 2)) % 2 = 0</div>
              <div>offset = 24 + 0 + 2 = 26, struct_align = 8</div>
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">void* p</div>
              <div>A = 8, pad = (8 - (26 % 8)) % 8 = 6</div>
              <div>offset = 26 + 6 + 8 = 40, struct_align = 8</div>
            </div>

            <p>From the last member iteration results we have</p>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div>final_offset = offset = 40</div>
              <div>struct_align = 8</div>
            </div>

            <p>we can now calculate the tail padding as</p>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">Tail padding</div>
              <div>tail = (8 - (40 % 8)) % 8 = 0</div>
            </div>

            <p>The total (finalized) struct size then becomes</p>
            <div className="bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono text-xs space-y-1">
              <div className="font-semibold text-gray-900 dark:text-white mb-1">Total struct size</div>
              <div>struct_size = final_offset + tail_padding</div>
              <div>struct_size = 40 + 0 = 40</div>
              <div>sizeof(Example) = 40</div>
            </div>
          </div>

          <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded border border-green-200 dark:border-green-800">
            <h3 className="font-semibold text-green-900 dark:text-green-100 mb-2">✅ Final Result (64-bit x86-64)</h3>
            <div className="font-mono text-sm font-bold text-green-900 dark:text-green-100">
              sizeof(struct Example) = <span className="text-2xl">40 bytes</span>
            </div>
            <p className="text-sm mt-2 text-green-800 dark:text-green-200">
              <strong>Padding breakdown:</strong> 3 bytes (before <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">i</code>) + 7 bytes (before <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">d</code>) + 6 bytes (before <code className="bg-green-100 dark:bg-green-900 px-1 rounded text-xs">p</code>) = <strong>16 bytes of wasted padding</strong>
            </p>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded border border-blue-200 dark:border-blue-800">
            <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">💡 Key Insight</h3>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              Out of 40 bytes, only 24 bytes are actual data (1+4+1+8+2+8). The remaining <strong>16 bytes are just padding holes</strong> — a 40% memory waste! By reordering members (double, void*, int32_t, int16_t, char, char), the offsets become 0, 8, 16, 20, 22, 23 and the struct shrinks to <strong>24 bytes with zero padding</strong> (24 is already a multiple of the 8-byte struct alignment, so no tail padding is needed).
            </p>
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Optimization Tips</h2>
        <ul className="space-y-2 text-gray-700 dark:text-gray-300 list-disc pl-5">
          <li>Prefer ordering by alignment class (highest to lowest), then by size as a heuristic.</li>
          <li>Group similarly aligned fields together.</li>
          <li>Place small fields near the end when possible.</li>
          <li>Use bit-fields sparingly and verify generated layout.</li>
          <li>Use packed layouts only when required and benchmark on target hardware.</li>
        </ul>
      </section>

      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-blue-900 dark:text-blue-100 mb-4">Compiler-specific Notes</h2>
        <ul className="space-y-3 text-gray-700 dark:text-gray-300 list-disc pl-5">
          <li><strong>GCC / Clang:</strong> support <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">__attribute__((packed))</code>, <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">__attribute__((aligned(n)))</code> and <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">#pragma pack</code>, including MSVC&apos;s <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">push</code>/<code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">pop</code> syntax for compatibility.</li>
          <li><strong>MSVC:</strong> <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">#pragma pack(n)</code> places each member on a multiple of n or of its own size, whichever is smaller, so it can only lower alignment. Layout differs from GCC/Clang mainly for <strong>bit-fields</strong> and packed structs (GCC can mimic MSVC with <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">-mms-bitfields</code> or <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded text-sm">__attribute__((ms_struct))</code>).</li>
          <li><strong>Embedded compilers:</strong> often provide vendor-specific packing keywords/pragmas.</li>
          <li><strong>Caveat:</strong> packed structs reduce padding but can produce unaligned accesses; this may degrade performance or cause faults on some architectures. Test on target toolchains and consider performance implications.</li>
        </ul>
      </section>


      <section className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
        <h2 className="text-2xl font-semibold text-red-700 dark:text-red-300 mb-4">Tool&apos;s Edge Cases & Limitations</h2>
        <div className="space-y-4 text-gray-700 dark:text-gray-300">
          <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded border border-red-200 dark:border-red-800">
            <h3 className="font-semibold text-red-900 dark:text-red-100 mb-2">Bit-fields</h3>
            <p className="text-sm text-red-800 dark:text-red-200">
              Bit-field layout is implementation-defined. Packing order, storage unit behavior, and zero-width bit-field semantics vary by compiler/ABI;
              the calculator applies the target compiler&apos;s rules (GCC and Clang, MSVC or SDCC).
            </p>
          </div>
          <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded border border-orange-200 dark:border-orange-800">
            <h3 className="font-semibold text-orange-900 dark:text-orange-100 mb-2">Packing Pragmas & Attributes</h3>
            <p className="text-sm text-orange-800 dark:text-orange-200">
              <code className="bg-orange-100 dark:bg-orange-900 px-1 rounded text-xs">#pragma pack(n)</code> and attributes such as{' '}
              <code className="bg-orange-100 dark:bg-orange-900 px-1 rounded text-xs">__attribute__((packed))</code> can override natural alignment.
            </p>
            <p className="text-sm text-orange-800 dark:text-orange-200 mt-2">
              This tool applies <code className="bg-orange-100 dark:bg-orange-900 px-1 rounded text-xs">#pragma pack(n)</code> (with push/pop), the packed and aligned attributes, and <code className="bg-orange-100 dark:bg-orange-900 px-1 rounded text-xs">alignas</code> as GCC and MSVC do: pack caps each member&apos;s alignment at n, and an explicit alignment request is never lowered by packing.
            </p>
          </div>
          <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded border border-purple-200 dark:border-purple-800">
            <h3 className="font-semibold text-purple-900 dark:text-purple-100 mb-2">C++ Object Model Cases</h3>
            <p className="text-sm text-purple-800 dark:text-purple-200">
              Inheritance-related optimizations (for example empty base class optimization) can produce layouts that differ from simple C-style formulas.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
