import type { Metadata, Viewport } from 'next';
import './globals.css';

// Mobile: shrink the layout when the on-screen keyboard opens, so the prompt box stays visible.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#0d0d0d',
};

export const metadata: Metadata = {
  title: 'Dobal: your AI assistant',
  description: 'Dobal: ask anything, chat with PDFs, and save explanations to your personal Notes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
