--
-- PostgreSQL database dump
--

\restrict dBxeZURRhgzaDLh2ia9owJVdIwbl1VwS429k1IVcZOFUciSem81rqxc3fZ3YZZI

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bets (
    id integer NOT NULL,
    sport text NOT NULL,
    game_id text NOT NULL,
    commence_time timestamp with time zone NOT NULL,
    home_team text NOT NULL,
    away_team text NOT NULL,
    market text NOT NULL,
    selection text NOT NULL,
    point double precision,
    american_odds double precision NOT NULL,
    units double precision NOT NULL,
    fair_odds double precision,
    ev_percent double precision,
    book text,
    closing_odds double precision,
    clv_percent double precision,
    status text DEFAULT 'pending'::text NOT NULL,
    pnl double precision,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: bets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bets_id_seq OWNED BY public.bets.id;


--
-- Name: pitcher_k_paper_trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pitcher_k_paper_trades (
    id integer NOT NULL,
    sport text NOT NULL,
    game_id text NOT NULL,
    commence_time timestamp with time zone NOT NULL,
    home_team text NOT NULL,
    away_team text NOT NULL,
    pitcher text NOT NULL,
    pitcher_id integer,
    team text NOT NULL,
    opponent text NOT NULL,
    selection text NOT NULL,
    point double precision NOT NULL,
    book text NOT NULL,
    american_odds double precision NOT NULL,
    model_prob double precision NOT NULL,
    market_prob double precision,
    edge_percent double precision,
    expected_strikeouts double precision NOT NULL,
    projected_batters_faced double precision NOT NULL,
    recommended_units double precision NOT NULL,
    kelly_multiplier double precision NOT NULL,
    closing_odds double precision,
    closing_prob double precision,
    clv_percent double precision,
    beat_close boolean,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_flagged boolean,
    deleted_at timestamp with time zone,
    actual_strikeouts integer,
    outcome text
);


--
-- Name: pitcher_k_paper_trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pitcher_k_paper_trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pitcher_k_paper_trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pitcher_k_paper_trades_id_seq OWNED BY public.pitcher_k_paper_trades.id;


--
-- Name: bets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bets ALTER COLUMN id SET DEFAULT nextval('public.bets_id_seq'::regclass);


--
-- Name: pitcher_k_paper_trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pitcher_k_paper_trades ALTER COLUMN id SET DEFAULT nextval('public.pitcher_k_paper_trades_id_seq'::regclass);


--
-- Data for Name: bets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bets (id, sport, game_id, commence_time, home_team, away_team, market, selection, point, american_odds, units, fair_odds, ev_percent, book, closing_odds, clv_percent, status, pnl, notes, created_at, deleted_at) FROM stdin;
1	baseball_mlb	demo-seed-1	2026-07-09 20:00:00+00	New York Yankees	Boston Red Sox	h2h	New York Yankees	\N	150	1	130	6.2	DraftKings	\N	\N	pending	\N	Line moved off open, took early value	2026-07-10 02:32:25.417197+00	\N
3	baseball_mlb	demo-seed-2	2026-07-08 23:00:00+00	Atlanta Braves	Philadelphia Phillies	totals	Under	8.5	-105	2	-118	4.1	FanDuel	\N	\N	pending	\N	\N	2026-07-10 02:33:37.603385+00	\N
\.


--
-- Data for Name: pitcher_k_paper_trades; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pitcher_k_paper_trades (id, sport, game_id, commence_time, home_team, away_team, pitcher, pitcher_id, team, opponent, selection, point, book, american_odds, model_prob, market_prob, edge_percent, expected_strikeouts, projected_batters_faced, recommended_units, kelly_multiplier, closing_odds, closing_prob, clv_percent, beat_close, status, created_at, is_flagged, deleted_at, actual_strikeouts, outcome) FROM stdin;
\.


--
-- Name: bets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.bets_id_seq', 3, true);


--
-- Name: pitcher_k_paper_trades_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pitcher_k_paper_trades_id_seq', 4, true);


--
-- Name: bets bets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bets
    ADD CONSTRAINT bets_pkey PRIMARY KEY (id);


--
-- Name: pitcher_k_paper_trades pitcher_k_paper_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pitcher_k_paper_trades
    ADD CONSTRAINT pitcher_k_paper_trades_pkey PRIMARY KEY (id);


--
-- Name: pitcher_k_paper_trades_pick_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pitcher_k_paper_trades_pick_uniq ON public.pitcher_k_paper_trades USING btree (game_id, pitcher, selection, point, book);


--
-- PostgreSQL database dump complete
--

\unrestrict dBxeZURRhgzaDLh2ia9owJVdIwbl1VwS429k1IVcZOFUciSem81rqxc3fZ3YZZI

