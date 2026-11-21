import { Button } from '@acme/ui';

export function Hero() {
  return (
    <section className="hero">
      <h1>Relatórios que se escrevem sozinhos</h1>
      <p>Conecte seus dados e receba um resumo toda segunda-feira.</p>
      <div className="actions">
        <Button href="/precos">Começar grátis</Button>
        <Button href="/blog" variant="ghost">Ver como funciona</Button>
      </div>
    </section>
  );
}
