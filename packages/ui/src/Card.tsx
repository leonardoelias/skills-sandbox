import styles from './Card.module.css';

type Props = { title: string; children: React.ReactNode; footer?: React.ReactNode };

export function Card({ title, children, footer }: Props) {
  return (
    <article className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.body}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </article>
  );
}
