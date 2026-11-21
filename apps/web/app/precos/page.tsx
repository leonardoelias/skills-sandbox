import { Button, Card } from '@acme/ui';

const plans = [
  { name: 'Grátis', price: 'R$ 0', items: 'Até 3 fontes de dados' },
  { name: 'Time', price: 'R$ 49', items: 'Fontes ilimitadas, 10 pessoas' },
  { name: 'Empresa', price: 'Fale com a gente', items: 'SSO, auditoria e suporte' },
];

export default function Precos() {
  return (
    <main>
      <h1>Preços</h1>
      <p>Comece grátis e mude de plano quando quiser.</p>
      <section className="pricing">
        {plans.map((p) => (
          <Card key={p.name} title={p.name} footer={<Button href="#">Escolher</Button>}>
            <p className="price">{p.price}</p>
            <p>{p.items}</p>
          </Card>
        ))}
      </section>
    </main>
  );
}
