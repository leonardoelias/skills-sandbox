import styles from './Header.module.css';

export function Header({ links }: { links: { href: string; label: string }[] }) {
  return (
    <header className={styles.header}>
      <a className={styles.brand} href="/">Acme</a>
      <nav className={styles.nav}>
        {links.map((l) => (
          <a key={l.href} href={l.href}>{l.label}</a>
        ))}
      </nav>
    </header>
  );
}
