import { Button } from '@acme/ui';

export default function Contato() {
  return (
    <main>
      <h1>Contato</h1>
      <p>Fale com o time comercial ou tire dúvidas sobre os planos. Respondemos em até um dia útil.</p>
      <form className="newsletter">
        <label htmlFor="msg-email">Seu e-mail</label>
        <input id="msg-email" type="email" placeholder="voce@empresa.com" />
        <label htmlFor="msg">Mensagem</label>
        <input id="msg" type="text" placeholder="Como podemos ajudar?" />
        <Button href="#">Enviar</Button>
      </form>
    </main>
  );
}
