"use client";

import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-800 p-6">
      <div className="max-w-3xl w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl p-8 flex flex-col items-center gap-6 text-center">
        <div className="w-full">
          <div className="flex items-center justify-center md:justify-start gap-4 mb-4">
            <div className="text-6xl font-extrabold text-red-600 dark:text-red-400">404</div>
            <div className="text-sm text-gray-500 dark:text-gray-400 uppercase tracking-wider">Page not found</div>
          </div>

          <h1 className="text-2xl md:text-3xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Oops — we can&apos;t find that page
          </h1>

          <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
            The page you are looking for may have been moved, removed, or never existed.
            Try returning home or check the URL for typos.
          </p>

          <div className="flex items-center gap-3 justify-center md:justify-start">
            <Link href="/" className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white shadow">
              Go Home
            </Link>
            <a href="#" onClick={(e)=>{e.preventDefault(); history.back();}} className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">
              Go Back
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
