# Bingo Website

A multiplayer Bingo web application matching the 15-screen modern UI blueprint.

## 📁 Files
- `index.html` - Complete website pages and screen layouts (Intro, Home, Create, Share, Join, Waiting, Game 5x5 & 7x7, History, Progress, Winner)
- `css/style.css` - Design, color palette, dark mode, responsive layout, animations, and micro-interactions
- `js/app.js` - Board generator, turn system, Web Audio API sound effects, canvas confetti, and cross-tab real-time sync
- `supabase/schema.sql` - Database table structure, RLS policies, and realtime publication setup for Supabase

## 🚀 How to Run
1. Open this folder in VS Code.
2. Install the **Live Server** extension (if not already installed).
3. Right-click on `index.html`.
4. Select **Open with Live Server**.
5. Or double-click `index.html` in your file explorer to open directly in any modern browser!

## 🎮 Board Rules & Features
- **5x5 Grid**: Numbers 1–25 in order or shuffled.
- **7x7 Grid**: Numbers 1–49 in order or shuffled.
- **🟢 Green**: Your selected numbers.
- **🟡 Yellow**: Friend's selected numbers (with blink animation on your screen).
- **Lines Progress**: Counts completed rows, columns, and diagonals.
- **B-I-N-G-O**: Lights up letter by letter as lines are completed (5 lines = BINGO victory!).
- **Multiplayer**: Supports local multi-tab real-time sync using `BroadcastChannel` and simulated bot friends for instant testing.
- **Dark Mode**: Toggle anytime via the moon/sun icon in the header or the blueprint dock.

## 🌟 Blueprint Navigator
Use the floating navigation bar at the bottom of the screen to quickly test and inspect all 15 screens from the reference blueprint:
1. Intro Screen (2s animated balls)
2. Home Page
3. Create Room (5x5 / 7x7, 2-4 players)
4. Room Created / Share Link
5. Join Room
6. Waiting Room (4 players)
7. Game Screen (5x5)
8. Game Screen (7x7)
9. Number Clicked - Your Turn (Green)
10. Friend Clicked - Blink on Your Screen (Yellow)
11. Number History (Live filtered)
12. BINGO Progress (B-I-N-G-O letters & checklist)
13. Winner Screen (Confetti & Crown celebration)
14. Mobile Responsive View
15. Dark Mode

## ☁️ Supabase Cloud Integration (Optional)
To deploy with true global multiplayer:
1. Create a project at [supabase.com](https://supabase.com).
2. Go to SQL Editor and run `supabase/schema.sql`.
3. Add your Supabase URL & Anon Key to `js/app.js`.

Enjoy playing BINGO! 🎉
