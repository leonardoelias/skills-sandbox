import styles from './Button.module.css';

type Props = { href: string; children: React.ReactNode; variant?: 'primary' | 'ghost' };

export function Button({ href, children, variant = 'primary' }: Props) {
  return (
    <a className={`${styles.button} ${variant === 'ghost' ? styles.ghost : ''}`} href={href}>
      {children}
    </a>
  );
}
