import { Header } from '@acme/ui';
import './globals.css';

export const metadata = { title: 'Acme' };

const links = [
  { href: '/', label: 'Início' },
  { href: '/precos', label: 'Preços' },
  { href: '/blog', label: 'Blog' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Header links={links} />
        {children}
      </body>
    </html>
  );
}
