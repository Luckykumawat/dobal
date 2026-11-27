import type { Metadata } from 'next';
import './globals.css';

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
