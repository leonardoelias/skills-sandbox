export const posts = [
  { slug: 'ola', title: 'Olá, mundo', date: '2026-11-01', body: 'O primeiro post do blog, só para ter conteúdo de verdade na página.' },
  { slug: 'relatorios-semanais', title: 'Como montamos os relatórios semanais', date: '2026-11-14', body: 'Juntamos as fontes, resumimos o que mudou e mandamos tudo numa página só.' },
];

export const findPost = (slug: string) => posts.find((p) => p.slug === slug);
