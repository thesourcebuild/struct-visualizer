import Button from '@/components/ui/Button';
import { SITE_DESCRIPTION, SITE_TITLE } from '@/lib/constants';
import { pageMetadata } from '@/lib/seo';

// The site's structured data (WebApplication) is rendered by the root layout.
export const metadata = pageMetadata({
  path: '/',
  title: `${SITE_TITLE} | Memory Layout Visualizer & Struct Padding Calculator`,
  description: SITE_DESCRIPTION,
  absoluteTitle: true,
});

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-900">

      {/* Hero Section */}
      <div className="pt-24 pb-24 px-6 flex-1 bg-gradient-to-b from-white via-blue-50 to-white dark:from-gray-900 dark:via-gray-800 dark:to-gray-900">
        <div className="max-w-4xl mx-auto text-center">
          <div className="mb-8 inline-block px-4 py-2 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-full text-sm font-semibold">
            ✨ C/C++ · Go · Rust · Zig
          </div>
          <h1 className="text-6xl md:text-7xl font-bold text-gray-900 dark:text-white mb-6 leading-tight tracking-tight">
            Master Struct <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">Padding</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-300 mb-12 leading-relaxed max-w-2xl mx-auto font-light">
            See every byte of your types in C/C++, Go, Rust and Zig: offsets, wasted padding, and the field order that fixes it, on x86, x64, ARM, RISC-V, WebAssembly and more.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button href="/tools" variant="primary" size="md">
              Launch Calculator
              <span className="ml-2">→</span>
            </Button>
            <Button href="#features" variant="secondary" size="md">
              Learn More
            </Button>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div id="features" className="py-24 px-6 bg-gradient-to-b from-gray-50 to-white dark:from-gray-800 dark:to-gray-900">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-5xl font-bold text-gray-900 dark:text-white mb-4">Powerful Features</h2>
            <p className="text-lg text-gray-600 dark:text-gray-400">Everything you need to understand struct memory layout</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Feature 1 */}
            <div className="p-8 bg-white dark:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-600 hover:shadow-xl hover:border-blue-400 dark:hover:border-blue-500 transition-all duration-300 group">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-100 to-blue-200 dark:from-blue-900 dark:to-blue-800 rounded-lg flex items-center justify-center mb-6 text-3xl group-hover:scale-110 transition-transform">
                🧩
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">C/C++, Go, Rust and Zig</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Each with its own rules: C ABIs and packing, Go&apos;s gc compiler, rustc&apos;s field reordering and enum niches, and Zig&apos;s extern, packed and tagged types.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="p-8 bg-white dark:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-600 hover:shadow-xl hover:border-purple-400 dark:hover:border-purple-500 transition-all duration-300 group">
              <div className="w-14 h-14 bg-gradient-to-br from-purple-100 to-purple-200 dark:from-purple-900 dark:to-purple-800 rounded-lg flex items-center justify-center mb-6 text-3xl group-hover:scale-110 transition-transform">
                📚
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">Multi-Architecture</h3>
              <p className="text-gray-600 dark:text-gray-400">
                x86, x64, ARM, RISC-V, WebAssembly, AVR, PIC and 8051, every Go architecture and the common Rust and Zig targets.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="p-8 bg-white dark:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-600 hover:shadow-xl hover:border-emerald-400 dark:hover:border-emerald-500 transition-all duration-300 group">
              <div className="w-14 h-14 bg-gradient-to-br from-emerald-100 to-emerald-200 dark:from-emerald-900 dark:to-emerald-800 rounded-lg flex items-center justify-center mb-6 text-3xl group-hover:scale-110 transition-transform">
                ⚡
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">Auto Optimize</h3>
              <p className="text-gray-600 dark:text-gray-400">
                The field order that wastes the least space, ready to copy, with what it saves on every target.
              </p>
            </div>

            {/* Feature 4 */}
            <div className="p-8 bg-white dark:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-600 hover:shadow-xl hover:border-rose-400 dark:hover:border-rose-500 transition-all duration-300 group">
              <div className="w-14 h-14 bg-gradient-to-br from-rose-100 to-rose-200 dark:from-rose-900 dark:to-rose-800 rounded-lg flex items-center justify-center mb-6 text-3xl group-hover:scale-110 transition-transform">
                ✅
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">Checked Against Compilers</h3>
              <p className="text-gray-600 dark:text-gray-400">
                Results are tested against GCC, MSVC, the Go compiler, rustc and zig, and every tool generates a program to check on yours.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* How It Works Section */}
      <div className="py-24 px-6 bg-white dark:bg-gray-900">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-5xl font-bold text-gray-900 dark:text-white mb-4">How It Works</h2>
            <p className="text-lg text-gray-600 dark:text-gray-400">Four simple steps to master struct padding</p>
          </div>
          <div className="space-y-6">
            {[
              { num: '1', title: 'Pick a Language', desc: 'Choose C/C++, Go, Rust or Zig in the sidebar, then paste a struct, union or enum, or load an example.' },
              { num: '2', title: 'Select a Target', desc: 'A CPU and data model for C, a GOARCH for Go, or a target triple for Rust and Zig.' },
              { num: '3', title: 'View Analysis', desc: 'See the byte map, padding statistics, diagnostics and the same type on every other target.' },
              { num: '4', title: 'Optimize & Verify', desc: 'Copy the reordered definition, and generate a C, Go, Rust or Zig program that prints what your compiler does.' },
            ].map((step, idx) => (
              <div key={idx} className="flex gap-6 items-start p-6 rounded-xl bg-gradient-to-r from-gray-50 to-transparent dark:from-gray-800 dark:to-transparent border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 transition-all duration-300 hover:shadow-md">
                <div className="flex-shrink-0 w-14 h-14 bg-gradient-to-br from-blue-600 to-purple-600 rounded-full flex items-center justify-center text-white font-bold text-xl shadow-lg">
                  {step.num}
                </div>
                <div className="flex-1">
                  <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{step.title}</h3>
                  <p className="text-gray-600 dark:text-gray-400 text-lg">
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="py-24 px-6 bg-gradient-to-r from-blue-600 via-purple-600 to-emerald-500 relative overflow-hidden">
        <div className="absolute inset-0 opacity-20 bg-[url('data:image/svg+xml,...')]"></div>
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <h2 className="text-5xl md:text-6xl font-bold text-white mb-6 leading-tight whitespace-nowrap">Learn, Understand, and Optimize</h2>
          <p className="text-xl text-blue-100 mb-10 max-w-2xl mx-auto">
            Deepen your understanding of memory layout, learn optimization techniques, and apply them confidently — <strong>No installation required</strong>, works in your browser.
          </p>
          <Button href="/tools" variant="secondary" size="lg">
            Launch Calculator
            <span className="ml-2">→</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
