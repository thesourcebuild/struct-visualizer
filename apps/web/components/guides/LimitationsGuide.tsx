import Link from 'next/link';

const CARD = 'bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 border-l-4';
const H2 = 'text-2xl font-bold text-gray-900 dark:text-white mb-3';
const P = 'text-gray-700 dark:text-gray-300 mb-3';
const UL = 'list-disc pl-5 space-y-2 text-gray-700 dark:text-gray-300';
const CODE = 'bg-gray-100 dark:bg-gray-900 px-1.5 py-0.5 rounded font-mono text-sm';

/**
 * The limitations guide body. Shared by the /limitations/ page and the in-app guide overlay.
 * Every statement here describes what the calculator actually does -- keep it in step with
 * @sp/core when the parser or calculator changes.
 */
export function LimitationsGuide() {
    return (
        <div className="space-y-8">
            <section className={`${CARD} border-orange-500`}>
                <h2 className={H2}>Compiler and ABI Differences</h2>
                <p className={P}>
                    Struct layout is fixed by the target&apos;s ABI, not by the C standard. The calculator models the common ABI rules for each
                    selected target, data model and OS, but your compiler can differ:
                </p>
                <ul className={UL}>
                    <li>GCC, Clang and MSVC agree for plain members on the same target, but can differ for bit-fields and packed structs.</li>
                    <li>Flags that change the ABI change the layout, e.g. <code className={CODE}>-malign-double</code>, <code className={CODE}>-fshort-enums</code>, <code className={CODE}>-mms-bitfields</code> or MSVC <code className={CODE}>/Zp</code>.</li>
                    <li>Optimization levels (<code className={CODE}>-O0</code>…<code className={CODE}>-O3</code>) do <strong>not</strong> change struct layout: it is part of the ABI and must match between separately compiled files.</li>
                </ul>
            </section>

            <section className={`${CARD} border-blue-500`}>
                <h2 className={H2}>Platform-Dependent Results</h2>
                <p className={P}>Sizes and alignments come from the selected data model and target. Toolchains for unusual or legacy platforms may use other values.</p>
                <ul className={UL}>
                    <li>
                        <strong>Data models:</strong> int, long and pointer sizes differ between LP64, LLP64, ILP32 and embedded compiler models.{' '}
                        <Link href="/tools/data-models/" className="text-blue-600 dark:text-blue-400 hover:underline">See the supported data models →</Link>
                    </li>
                    <li><strong>Endianness:</strong> does not change sizes or offsets, but it changes the byte order inside each member and the order bit-fields are allocated in.</li>
                    <li><strong>Custom toolchains:</strong> embedded compilers often have their own type sizes and packing keywords.</li>
                </ul>
            </section>

            <section className={`${CARD} border-purple-500`}>
                <h2 className={H2}>Bit-Fields Follow Each Compiler</h2>
                <p className={P}>
                    Bit-field layout is implementation-defined, so the calculator uses the target compiler&apos;s rules: GCC and Clang outside
                    Windows, MSVC on Windows, SDCC on the 8051. Each field is placed at an exact bit, and the walkthrough shows its bit range.
                </p>
                <ul className={UL}>
                    <li>
                        Checked against the compilers: GCC for x86, x86-64, ARM, AArch64 Linux, RISC-V, MIPS and AVR; MinGW for Windows (it follows
                        MSVC&apos;s rules by default); SDCC for the 8051.
                    </li>
                    <li>
                        Not checked: XC16, Keil C51 and bare-metal AArch64 use GCC&apos;s rules for their kind of target, and the calculator says so
                        (SP004).
                    </li>
                    <li>Bits are numbered from the least significant bit of each byte, as these little-endian targets allocate them.</li>
                    <li>Whether a plain <code className={CODE}>int</code> bit-field is signed is implementation-defined.</li>
                </ul>
            </section>

            <section className={`${CARD} border-red-500`}>
                <h2 className={H2}>Attributes, Pragmas and Macros</h2>
                <p className={P}>These are read from your code and applied to the layout:</p>
                <ul className={UL}>
                    <li><code className={CODE}>#pragma pack(n)</code> with <code className={CODE}>push</code>/<code className={CODE}>pop</code>, and <code className={CODE}>__attribute__((packed))</code>, including packed enums.</li>
                    <li><code className={CODE}>__attribute__((aligned(n)))</code>, <code className={CODE}>alignas</code> / <code className={CODE}>_Alignas</code> and <code className={CODE}>__declspec(align(n))</code>, on structs and members.</li>
                    <li><code className={CODE}>#define</code> macros, object-like and function-like, with <code className={CODE}>#</code>, <code className={CODE}>##</code> and <code className={CODE}>__VA_ARGS__</code>, and <code className={CODE}>#if</code> / <code className={CODE}>#ifdef</code> blocks. <code className={CODE}>#include</code> is skipped; the standard fixed-width and size types are built in.</li>
                    <li><code className={CODE}>sizeof</code>, <code className={CODE}>_Alignof</code>, <code className={CODE}>offsetof</code> and casts in array sizes, bit-field widths and enum values, worked out for the selected target; <code className={CODE}>_Static_assert</code> is checked.</li>
                </ul>
                <p className={`${P} mt-3`}>Not modelled, and reported when they appear:</p>
                <ul className={UL}>
                    <li>No macro is predefined: <code className={CODE}>#ifdef _WIN32</code> or <code className={CODE}>#if __SIZEOF_LONG__ == 8</code> takes the branch for an undefined macro on every target.</li>
                    <li><code className={CODE}>__attribute__((mode))</code>, <code className={CODE}>vector_size</code> and <code className={CODE}>ms_struct</code>.</li>
                    <li>Pragmas other than <code className={CODE}>pack</code> and <code className={CODE}>once</code>, which are ignored.</li>
                </ul>
            </section>

            <section className={`${CARD} border-green-500`}>
                <h2 className={H2}>C++ Class Features</h2>
                <p className={P}>
                    Methods, constructors, static members, access specifiers, nested types and default member initializers are understood: they
                    take no space and do not change the layout. Not simulated:
                </p>
                <ul className={UL}>
                    <li>Inheritance, single or multiple, including the empty base optimization (reported as an error)</li>
                    <li>The hidden vtable pointer of classes with virtual functions (reported as a warning)</li>
                    <li>Templates, which have no layout until instantiated</li>
                    <li><code className={CODE}>[[no_unique_address]]</code> members (reported as a warning)</li>
                </ul>
            </section>

            <section className="bg-gradient-to-r from-blue-50 to-cyan-50 dark:from-blue-900/20 dark:to-cyan-900/20 rounded-lg shadow-md p-8 border-l-4 border-cyan-500">
                <h2 className={H2}>Always Verify</h2>
                <p className="text-gray-700 dark:text-gray-300 mb-4">
                    <strong>Check results with your actual compiler and target.</strong> The Verification Code tool generates a program that prints
                    these values for every member:
                </p>
                <div className="bg-white dark:bg-gray-800 p-4 rounded font-mono text-sm text-gray-800 dark:text-gray-200 space-y-2">
                    <p><span className="text-blue-600 dark:text-blue-400">{'// Check struct size'}</span></p>
                    <p><span className="text-blue-600 dark:text-blue-400">printf</span>(<span className="text-green-600 dark:text-green-400">{'"%zu\\n"'}</span>, <span className="text-purple-600 dark:text-purple-400">sizeof</span>(struct MyStruct));</p>
                    <p className="mt-3"><span className="text-blue-600 dark:text-blue-400">{'// Check member offset'}</span></p>
                    <p><span className="text-blue-600 dark:text-blue-400">printf</span>(<span className="text-green-600 dark:text-green-400">{'"%zu\\n"'}</span>, <span className="text-purple-600 dark:text-purple-400">offsetof</span>(struct MyStruct, member));</p>
                </div>
            </section>

            <section className={`${CARD} border-gray-500`}>
                <h2 className={H2}>Final Note</h2>
                <p className="text-gray-700 dark:text-gray-300">
                    This calculator is provided as-is for educational purposes. Struct layout is inherently platform- and compiler-dependent, and the
                    authors assume no liability for errors or discrepancies. Validate results in your own development environment before relying on
                    them in production code.
                </p>
            </section>
        </div>
    );
}
