import { Card } from '@acme/ui';
import { Hero } from '@/components/Hero';
import { Newsletter } from '@/components/Newsletter';

export default function Home() {
  return (
    <main>
      <Hero />
      <h2 className="section-title">Recursos</h2>
      <section className="features">
        <Card title="Rápido"><p>Configuração em cinco minutos.</p></Card>
        <Card title="Seguro"><p>Dados criptografados em repouso.</p></Card>
        <Card title="Simples"><p>Sem planilhas, sem fórmulas.</p></Card>
      </section>
      <section className="features">
        <Card title="Integrações"><p>Planilhas, bancos e ferramentas de BI.</p></Card>
        <Card title="Alertas"><p>Avisos quando um número sai do normal.</p></Card>
      </section>
      <Newsletter />
    </main>
  );
}
