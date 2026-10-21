'use client';

import React from 'react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  errors?: Array<{ message: string; line?: number }>;
  warnings?: Array<{ message: string; line?: number }>;
}
export default function CodeEditor({ value, onChange, readOnly = false, placeholder, errors = [], warnings = [] }: CodeEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const lines = value.split('\n');
  const lineNumbers = lines.map((_, i) => i + 1);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-white dark:bg-gray-900">
        {/* Line numbers */}
        <div className="bg-gray-100 dark:bg-gray-800 px-3 py-4 text-right select-none border-r border-gray-300 dark:border-gray-600">
          {lineNumbers.map((num) => (
            <div
              key={num}
              className="text-sm font-mono text-gray-500 dark:text-gray-400 leading-6"
            >
              {num}
            </div>
          ))}
        </div>

        {/* Code textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { if (!readOnly) onChange(e.target.value); }}
          readOnly={readOnly}
          className={`flex-1 px-4 py-4 font-mono text-sm bg-transparent text-gray-900 dark:text-gray-100 resize-none focus:outline-none leading-6 ${readOnly ? 'opacity-95' : ''}`}
          spellCheck={false}
          placeholder={placeholder}
          style={{
            tabSize: 4,
          }}
        />
      </div>

      {/* Error and warning messages */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="mt-3 space-y-2">
          {errors.map((error, index) => (
            <div
              key={`error-${index}`}
              className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
            >
              <svg
                className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800 dark:text-red-200">Error</p>
                <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error.message}</p>
              </div>
            </div>
          ))}

          {warnings.map((warning, index) => (
            <div
              key={`warning-${index}`}
              className="flex items-start gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg"
            >
              <svg
                className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">Warning</p>
                <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                  {warning.message}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
