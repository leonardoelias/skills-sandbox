import { notFound } from 'next/navigation';
import { findPost, posts } from '@/lib/posts';

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  return (
    <main className="post">
      <h1>{post.title}</h1>
      <p className="meta">{post.date}</p>
      <p>{post.body}</p>
    </main>
  );
}
