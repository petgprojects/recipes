import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

/**
 * Deliberately bare. The design system is `src/styles/artifact.css`, ported
 * from `meal-prep-planner.jsx`; there is no Tailwind or component library in
 * this project. The only thing the root layout adds is the query client, which
 * has to wrap every route that polls.
 */

export const metadata: Metadata = {
  title: 'Recipe Planner',
  description: 'Self-hosted meal-prep recipe planner.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
