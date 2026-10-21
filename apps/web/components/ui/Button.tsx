"use client";

import Link from 'next/link';
import React from 'react';

type ButtonProps = React.PropsWithChildren<{
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  className?: string;
  target?: string;
}>;

export default function Button({
  href,
  onClick,
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  target,
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-semibold rounded-xl focus:outline-none focus:ring-4 transition-transform';
  const sizes: Record<string, string> = {
    md: 'px-6 py-3 text-md',
    lg: 'px-10 py-4 text-lg',
  };

  const variants: Record<string, string> = {
    primary:
      'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg hover:scale-[1.03] hover:shadow-2xl active:translate-y-0.5 focus:ring-blue-300',
    secondary:
      'bg-white text-blue-700 border border-white/20 dark:border-gray-700 dark:bg-gray-800 dark:text-white shadow-md hover:scale-[1.02] active:translate-y-0.5 focus:ring-gray-200',
    ghost: 'bg-transparent text-gray-900 dark:text-white hover:bg-gray-100/40',
  };

  const classes = `${base} ${sizes[size]} ${variants[variant]} ${className}`;

  if (href) {
    return (
      <Link href={href} target={target} className={classes} onClick={onClick}>
        {children}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={classes}>
      {children}
    </button>
  );
}
