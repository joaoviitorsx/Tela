/**
 * Registra o comando `/tela` do app do Discord (docs/DISCORD.md).
 *
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/discord-registrar.mjs
 *
 * Roda na máquina do dono, uma vez (e de novo só se o comando mudar). O token
 * do bot serve SÓ para isto: não vai para o repositório, nem para o Worker,
 * nem para a saída deste script.
 *
 * `PUT` na lista de comandos globais substitui a lista inteira — o app só tem
 * este comando, então rodar duas vezes dá no mesmo. Comando global leva até
 * uma hora para aparecer em todo lugar; costuma ser bem menos.
 */

const id = process.env.DISCORD_APPLICATION_ID?.trim() ?? '';
const token = process.env.DISCORD_BOT_TOKEN?.trim() ?? '';

if (!/^\d{5,25}$/.test(id) || token === '') {
  console.error('Faltam DISCORD_APPLICATION_ID e/ou DISCORD_BOT_TOKEN no ambiente. Ver docs/DISCORD.md.');
  process.exit(1);
}

/**
 * - `integration_types: [0, 1]` — instalável no servidor (0) E no usuário
 *   (1). O 1 é o que faz o comando aparecer no "+" → "Usar apps" em qualquer
 *   servidor, DM ou grupo, sem ninguém precisar adicionar bot a servidor.
 * - `contexts: [0, 1, 2]` — servidor, DM com o bot e DM/grupo privado.
 * - Os nomes ficam em minúsculas sem acento: é a regra do Discord para
 *   nome de comando e de opção.
 */
const comandos = [
  {
    name: 'tela',
    type: 1,
    description: 'Manda o link do seu canal do Tela, dizendo se está ao vivo e quantos assistem',
    integration_types: [0, 1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'canal',
        description: 'O nome do canal: o que vem depois da barra no link',
        required: false,
        min_length: 3,
        // Cabe o link inteiro colado, não só o nome.
        max_length: 200,
      },
    ],
  },
];

const resposta = await fetch(`https://discord.com/api/v10/applications/${id}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(comandos),
});

if (!resposta.ok) {
  // O corpo de erro do Discord descreve o campo recusado; não ecoa o token.
  console.error(`Discord recusou (${resposta.status}): ${await resposta.text()}`);
  process.exit(1);
}

const registrados = await resposta.json();
for (const c of registrados) console.log(`registrado: /${c.name} (id ${c.id})`);
console.log(`\nLink de instalação: https://discord.com/oauth2/authorize?client_id=${id}`);
