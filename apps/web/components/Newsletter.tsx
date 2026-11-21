import { Button } from '@acme/ui';

export function Newsletter() {
  return (
    <form className="newsletter">
      <label htmlFor="email">E-mail de trabalho</label>
      <input id="email" type="email" placeholder="voce@empresa.com" />
      <Button href="#">Assinar</Button>
    </form>
  );
}
