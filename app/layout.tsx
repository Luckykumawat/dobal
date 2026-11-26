import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI PDF Chat',
  description: 'Upload a PDF and ask questions about it, powered by Gemini + Supabase pgvector',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
