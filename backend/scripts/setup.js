'use strict';
// Cria o arquivo .env com uma chave secreta aleatória.
// Uso: npm run setup            ou        npm run setup -- seu@email.com
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const adminArg = (process.argv[2] || '').trim().toLowerCase();

let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : example;
const setVar = (key, value, onlyIfEmpty) => {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = text.match(re);
  if (m && onlyIfEmpty && m[1].trim()) return false;
  text = m ? text.replace(re, `${key}=${value}`) : text + `\n${key}=${value}\n`;
  return true;
};

const madeSecret = setVar('APP_SECRET', crypto.randomBytes(32).toString('hex'), true);
if (adminArg) setVar('ADMIN_EMAIL', adminArg, false);
fs.writeFileSync(envFile, text);

console.log(fs.existsSync(envFile) && !madeSecret ? '.env já existia: mantive sua chave secreta.' : '.env criado com uma chave secreta nova.');
console.log(adminArg ? `Administrador: ${adminArg}` : 'Dica: rode  npm run setup -- seu@email.com  para definir o administrador.');
console.log('Guarde o .env com cuidado: se perder o APP_SECRET, os tokens salvos dos bots não podem mais ser lidos.');
console.log('Agora inicie com:  npm start');
