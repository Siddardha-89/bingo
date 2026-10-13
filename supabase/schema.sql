-- ===================================================
-- BINGO Multiplayer - Supabase Database Schema
-- ===================================================

-- Enable UUID extension if needed
create extension if not exists "uuid-ossp";

-- 1. Rooms Table
create table if not exists public.bingo_rooms (
    code text primary key,
    host_name text not null default 'Host',
    board_size integer not null check (board_size in (5, 7)),
    player_limit integer not null check (player_limit between 2 and 4),
    status text not null default 'waiting' check (status in ('waiting', 'playing', 'finished')),
    current_turn text,
    winner_name text,
    created_at timestamptz default now()
);

-- 2. Players Table
create table if not exists public.bingo_players (
    id bigint generated always as identity,
    room_code text not null references public.bingo_rooms(code) on delete cascade,
    player_id text not null,
    player_name text not null,
    is_host boolean not null default false,
    is_ready boolean not null default true,
    lines_completed integer not null default 0,
    board_numbers jsonb,
    joined_at timestamptz default now(),
    primary key (room_code, player_id)
);

-- 3. Selections / Moves Table
create table if not exists public.bingo_selections (
    id bigint generated always as identity primary key,
    room_code text not null references public.bingo_rooms(code) on delete cascade,
    player_id text not null,
    player_name text not null,
    number integer not null check (number between 1 and 49),
    selected_at timestamptz default now()
);

-- Indexes for lightning fast lookups
create index if not exists idx_bingo_players_room on public.bingo_players(room_code);
create index if not exists idx_bingo_selections_room on public.bingo_selections(room_code);

-- Enable Row Level Security (RLS)
alter table public.bingo_rooms enable row level security;
alter table public.bingo_players enable row level security;
alter table public.bingo_selections enable row level security;

-- Permissive public policies for demo & game play
create policy "Allow all actions on bingo_rooms" 
    on public.bingo_rooms for all using (true) with check (true);

create policy "Allow all actions on bingo_players" 
    on public.bingo_players for all using (true) with check (true);

create policy "Allow all actions on bingo_selections" 
    on public.bingo_selections for all using (true) with check (true);

-- Enable Supabase Realtime for instant synchronization
alter publication supabase_realtime add table public.bingo_rooms;
alter publication supabase_realtime add table public.bingo_players;
alter publication supabase_realtime add table public.bingo_selections;
