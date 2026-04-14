const { customAlphabet } = require('nanoid');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const nanoid16 = customAlphabet(ALPHABET, 16);
const nanoid12 = customAlphabet(ALPHABET, 12);
const nanoid10 = customAlphabet(ALPHABET, 10);
const nanoid32 = customAlphabet(ALPHABET, 32);

module.exports = { nanoid16, nanoid12, nanoid10, nanoid32 };
