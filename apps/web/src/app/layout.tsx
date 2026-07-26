import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Deliberately bare. PLAN.md §5 Phase 3 ports `meal-prep-planner.jsx` and its
 * CSS (already sitting in `src/styles/artifact.css`) — that is the design
 * system, and there is no Tailwind or component library in this project. Adding
 * global styling here would only have to be deleted then.
 */

export const metadata: Metadata = {
  title: 'Recipe Planner',
  description: 'Self-hosted meal-prep recipe planner — Phase 0 scaffold.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
