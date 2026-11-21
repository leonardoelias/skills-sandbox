import { posts } from '@/lib/posts';

export default function Blog() {
  return (
    <main>
      <h1>Blog</h1>
      <ul className="posts">
        {posts.map((p) => (
          <li key={p.slug}>
            <a href={`/blog/${p.slug}`}>{p.title}</a>
            <p>{p.body}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
