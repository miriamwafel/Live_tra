<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# LiveScribe PL - Transkrypcja na żywo

Aplikacja do transkrypcji mowy na żywo z wykorzystaniem Google Gemini API.

## Funkcje

- Transkrypcja mowy w czasie rzeczywistym (polski)
- Automatyczne ponowne łączenie przy zerwaniu połączenia
- Keep-alive do utrzymania długich sesji
- Eksport transkrypcji do pliku TXT

## Uruchom lokalnie

**Wymagania:** Node.js 18+

1. Zainstaluj zależności:
   ```bash
   npm install
   ```

2. Utwórz plik `.env.local` z kluczem API:
   ```
   GEMINI_API_KEY=twój_klucz_api
   ```

3. Uruchom aplikację:
   ```bash
   npm run dev
   ```

## Wdrożenie na Vercel

### Opcja 1: Przez Vercel Dashboard

1. Przejdź do [vercel.com](https://vercel.com) i zaloguj się
2. Kliknij "Add New..." → "Project"
3. Zaimportuj repozytorium z GitHub
4. W sekcji "Environment Variables" dodaj:
   - Nazwa: `GEMINI_API_KEY`
   - Wartość: Twój klucz API Gemini
5. Kliknij "Deploy"

### Opcja 2: Przez Vercel CLI

1. Zainstaluj Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Zaloguj się:
   ```bash
   vercel login
   ```

3. Wdróż:
   ```bash
   vercel --prod
   ```

4. Ustaw zmienną środowiskową w panelu Vercel:
   - Przejdź do Settings → Environment Variables
   - Dodaj `GEMINI_API_KEY` z wartością klucza API

## Uzyskanie klucza API Gemini

1. Przejdź do [Google AI Studio](https://aistudio.google.com/apikey)
2. Kliknij "Create API Key"
3. Skopiuj wygenerowany klucz
