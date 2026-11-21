package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	wire "github.com/jack-work/figaro/api/aria"
	"github.com/jack-work/figaro/api/livedoc"
	"github.com/jack-work/figaro/sdk/aria"
)

type jsonMessage struct {
	Turn            int                          `json:"turn"`
	From            uint64                       `json:"from"`
	Inquiry         string                       `json:"inquiry,omitempty"`
	InquirySegments []wire.InquirySegment        `json:"inquirySegments,omitempty"`
	InquiryLT       uint64                       `json:"inquiryLT,omitempty"`
	FormDeltas      map[string]livedoc.FormDelta `json:"formDeltas,omitempty"`
	ForkedFrom      string                       `json:"forkedFrom,omitempty"`
	Role            string                       `json:"role"`
	Nodes           []livedoc.Node               `json:"nodes"`
}

func msg(m aria.Message) jsonMessage {
	nodes := m.Nodes
	if nodes == nil {
		nodes = []livedoc.Node{}
	}
	return jsonMessage{m.Turn, m.From, m.Inquiry, m.InquirySegments, m.InquiryLT, m.FormDeltas, m.ForkedFrom, m.Role, nodes}
}

func msgs(in []aria.Message) []jsonMessage {
	out := make([]jsonMessage, 0, len(in))
	for _, m := range in {
		out = append(out, msg(m))
	}
	return out
}

type jsonGap struct {
	From aria.Anchor `json:"from"`
	To   aria.Anchor `json:"to"`
}

type jsonSegment struct {
	Msgs []jsonMessage `json:"msgs"`
	Gap  *jsonGap      `json:"gap,omitempty"`
}

type jsonExtent struct {
	Before bool `json:"before"`
	After  bool `json:"after"`
}

type step struct {
	Op    string       `json:"op"`
	Page  *aria.Page   `json:"page,omitempty"`
	Quiet bool         `json:"quiet,omitempty"`
	V     bool         `json:"v,omitempty"`
	From  *aria.Anchor `json:"from,omitempty"`
	To    *aria.Anchor `json:"to,omitempty"`
	At    *aria.Anchor `json:"at,omitempty"`
	N     int          `json:"n,omitempty"`
	Len   uint64       `json:"len,omitempty"`
	Pages []aria.Page  `json:"pages,omitempty"`
}

type state struct {
	Cursor         int          `json:"cursor"`
	Count          int          `json:"count"`
	More           jsonExtent   `json:"more"`
	OpenTurn       int          `json:"openTurn"`
	OpenFrom       uint64       `json:"openFrom"`
	OpenAnimating  bool         `json:"openAnimating"`
	Heard          bool         `json:"heard"`
	Revision       uint64       `json:"revision"`
	ClosedRevision uint64       `json:"closedRevision"`
	FirstMissing   int          `json:"firstMissing"`
	HasMissing     bool         `json:"hasMissing"`
	Top            *aria.Anchor `json:"top,omitempty"`
}

type result struct {
	Closed   []jsonMessage `json:"closed,omitempty"`
	Open     *jsonMessage  `json:"open,omitempty"`
	Desync   *int          `json:"desync,omitempty"`
	Metrics  *aria.Metrics `json:"metrics,omitempty"`
	Segments []jsonSegment `json:"segments,omitempty"`
	Anchor   *aria.Anchor  `json:"anchor,omitempty"`
	Found    *bool         `json:"found,omitempty"`
	Moved    *int          `json:"moved,omitempty"`
	Err      string        `json:"err,omitempty"`
	Fetched  []fetchedCall `json:"fetched,omitempty"`
	View     *jsonView     `json:"view,omitempty"`
	Inquiry  *jsonInquiry  `json:"inquiry,omitempty"`
	Flag     *bool         `json:"flag,omitempty"`
	State    state         `json:"state"`
}

type fetchedCall struct {
	Before aria.Anchor `json:"before"`
	Limit  int         `json:"limit"`
}

type jsonView struct {
	Closed []jsonMessage `json:"closed"`
	Open   *jsonMessage  `json:"open,omitempty"`
}

type jsonInquiry struct {
	Text       string                       `json:"text"`
	Segments   []wire.InquirySegment        `json:"segments,omitempty"`
	FormDeltas map[string]livedoc.FormDelta `json:"formDeltas,omitempty"`
	ForkedFrom string                       `json:"forkedFrom,omitempty"`
	LT         uint64                       `json:"lt,omitempty"`
}

type fixture struct {
	Name   string   `json:"name"`
	Note   string   `json:"note"`
	Steps  []step   `json:"steps"`
	Expect []result `json:"expect"`
}

func flag_(b bool) *bool { return &b }

func snapshot(c *aria.Client) state {
	s := state{
		Cursor:         c.Cursor(),
		Count:          c.Count(),
		More:           jsonExtent{c.MoreBefore(), c.MoreAfter()},
		OpenAnimating:  c.OpenAnimating(),
		Heard:          c.Heard(),
		Revision:       c.Revision(),
		ClosedRevision: c.ClosedRevision(),
	}
	if turn, from, ok := c.OpenKey(); ok {
		s.OpenTurn, s.OpenFrom = turn, from
	}
	s.FirstMissing, s.HasMissing = c.FirstMissing()
	if top, ok := c.Store().Top(); ok {
		s.Top = &top
	}
	return s
}

func segments(in []aria.Segment) []jsonSegment {
	out := make([]jsonSegment, 0, len(in))
	for _, s := range in {
		js := jsonSegment{Msgs: msgs(s.Msgs)}
		if s.Gap != nil {
			js.Gap = &jsonGap{s.Gap.From, s.Gap.To}
		}
		out = append(out, js)
	}
	return out
}

type runner struct {
	c *aria.Client
}

func (r *runner) run(s step) result {
	var res result
	switch s.Op {
	case "apply":
		var desync = -1
		var metrics *aria.Metrics
		var closed []aria.Message
		var open *aria.Message
		r.c.OnClosed = func(m aria.Message) { closed = append(closed, m) }
		r.c.OnLive = func(m aria.Message) { open = &m }
		r.c.OnDesync = func(n int) { desync = n }
		r.c.OnMetrics = func(m aria.Metrics) { metrics = &m }
		mode := aria.Notify
		if s.Quiet {
			mode = aria.Quiet
		}
		ret := r.c.Apply(*s.Page, mode)
		if s.Quiet {
			closed = ret
		}
		res.Closed = msgs(closed)
		if open != nil {
			m := msg(*open)
			res.Open = &m
		}
		if desync >= 0 {
			res.Desync = &desync
		}
		res.Metrics = metrics
	case "setMoreBefore":
		r.c.SetMoreBefore(s.V)
	case "setMoreAfter":
		r.c.SetMoreAfter(s.V)
	case "query":
		res.Segments = segments(r.c.Query(*s.From, *s.To))
	case "evictBefore":
		r.c.EvictBefore(*s.At)
	case "closedLimit":
		r.c.SetClosedLimit(s.N)
	case "cloneBelow":
		r.c = r.c.CloneBelow(s.N)
	case "tailFrom":
		a, ok := r.c.TailFrom(s.N)
		res.Anchor, res.Found = &a, flag_(ok)
	case "skip":
		a, ok := r.c.Skip(*s.At, s.N)
		res.Anchor, res.Found = &a, flag_(ok)
	case "before":
		a, n := r.c.Before(*s.At, s.N)
		res.Anchor, res.Moved = &a, &n
	case "contiguous":
		res.Flag = flag_(r.c.Contiguous(*s.At))
	case "view":
		v := r.c.View()
		jv := jsonView{Closed: msgs(v.Closed)}
		if v.Open != nil {
			m := msg(*v.Open)
			jv.Open = &m
		}
		res.View = &jv
	case "inquiryOf":
		q, ok := r.c.InquiryOf(s.N)
		res.Flag = flag_(ok)
		if ok {
			res.Inquiry = &jsonInquiry{q.Text, q.Segments, q.FormDeltas, q.ForkedFrom, q.LT}
		}
	case "setTurnLen":
		r.c.Store().SetTurnLen(uint64(s.N), s.Len)
	case "ensure":
		next := 0
		var calls []fetchedCall
		r.c.SetFetcher(func(ctx context.Context, before aria.Anchor, limit int) (aria.Page, error) {
			calls = append(calls, fetchedCall{before, limit})
			if next >= len(s.Pages) {
				return aria.Page{}, errors.New("no more pages")
			}
			p := s.Pages[next]
			next++
			return p, nil
		})
		if err := r.c.Ensure(context.Background(), *s.From, *s.To); err != nil {
			res.Err = err.Error()
		}
		res.Fetched = calls
	default:
		panic("unknown op " + s.Op)
	}
	res.State = snapshot(r.c)
	return res
}

func play(name, note string, steps []step) fixture {
	r := &runner{c: aria.NewClient()}
	f := fixture{Name: name, Note: note, Steps: steps}
	for _, s := range steps {
		f.Expect = append(f.Expect, r.run(s))
	}
	return f
}

type tapeLine struct {
	Dir    string          `json:"dir"`
	ID     *int64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Msg    json.RawMessage `json:"msg"`
}

func readLines(path string) ([]tapeLine, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	var out []tapeLine
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 1<<20), 1<<28)
	for sc.Scan() {
		raw := bytes.TrimSpace(sc.Bytes())
		if len(raw) == 0 {
			continue
		}
		var l tapeLine
		if err := json.Unmarshal(raw, &l); err != nil {
			return nil, err
		}
		if l.Msg != nil {
			var inner tapeLine
			if json.Unmarshal(l.Msg, &inner) == nil {
				inner.Dir = l.Dir
				l = inner
			}
		}
		out = append(out, l)
	}
	return out, sc.Err()
}

func tapePages(path string) ([]aria.Page, error) {
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	asked := map[int64]string{}
	var out []aria.Page
	var outID int64
	for _, l := range lines {
		switch {
		case l.Dir == "out" && l.Method != "":
			if l.ID != nil {
				asked[*l.ID] = l.Method
			} else {
				outID++
				asked[outID] = l.Method
			}
		case l.Dir == "push" || (l.Dir == "in" && l.Method != ""):
			if l.Method != "figaro.aria" {
				continue
			}
			var p aria.Page
			if err := json.Unmarshal(l.Params, &p); err != nil {
				return nil, err
			}
			out = append(out, p)
		case l.Dir == "in" && l.ID != nil && asked[*l.ID] == "figaro.read":
			var p aria.Page
			if err := json.Unmarshal(l.Result, &p); err != nil {
				return nil, err
			}
			out = append(out, p)
		}
	}
	return out, nil
}

func applies(pages []aria.Page) []step {
	var out []step
	for i := range pages {
		p := pages[i]
		out = append(out, step{Op: "apply", Page: &p})
	}
	return out
}

func sealedParts(pages []aria.Page) []aria.Page {
	last := map[uint64]aria.Page{}
	for _, p := range pages {
		for _, part := range p.Parts {
			if part.Sealed && len(part.Nodes) > 0 && part.From == 0 && part.Live == nil {
				cp := part
				cp.Inquiry = firstInquiry(pages, part.ID)
				last[part.ID] = aria.Page{Parts: []aria.TurnPart{cp}}
			}
		}
	}
	ids := make([]uint64, 0, len(last))
	for id := range last {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	out := make([]aria.Page, 0, len(ids))
	for _, id := range ids {
		out = append(out, last[id])
	}
	return out
}

func firstInquiry(pages []aria.Page, turn uint64) string {
	for _, p := range pages {
		for _, part := range p.Parts {
			if part.ID == turn && part.Inquiry != "" {
				return part.Inquiry
			}
		}
	}
	return ""
}

func anchor(t, n uint64) *aria.Anchor { return &aria.Anchor{Turn: t, Node: n} }

func windowSteps(turns []uint64) []step {
	if len(turns) == 0 {
		return nil
	}
	lo, hi := turns[0], turns[len(turns)-1]
	mid := turns[len(turns)/2]
	steps := []step{
		{Op: "query", From: anchor(0, 0), To: anchor(hi+3, 0)},
		{Op: "query", From: anchor(lo, 0), To: anchor(hi, 1<<40)},
		{Op: "query", From: anchor(mid, 0), To: anchor(mid, 0)},
		{Op: "tailFrom", N: 1},
		{Op: "tailFrom", N: 2},
		{Op: "skip", At: anchor(lo, 0), N: 1},
		{Op: "before", At: anchor(hi, 0), N: 2},
		{Op: "contiguous", At: anchor(lo, 0)},
		{Op: "setMoreBefore", V: true},
		{Op: "query", From: anchor(0, 0), To: anchor(hi, 1<<40)},
		{Op: "setMoreAfter", V: true},
		{Op: "query", From: anchor(lo, 0), To: anchor(hi+5, 0)},
		{Op: "view"},
	}
	return steps
}

var variants = map[string][]string{
	"spike":           {"replay", "gappy"},
	"stream-eager":    {"replay"},
	"stream-buffered": {"replay"},
}

func wanted(name, variant string) bool {
	want, ok := variants[name]
	if !ok {
		return true
	}
	for _, w := range want {
		if w == variant {
			return true
		}
	}
	return false
}

func scenarios(name string, pages []aria.Page) []fixture {
	all := allScenarios(name, pages)
	var out []fixture
	for _, f := range all {
		if wanted(name, strings.TrimPrefix(f.Name, name+"/")) {
			out = append(out, f)
		}
	}
	return out
}

func allScenarios(name string, pages []aria.Page) []fixture {
	var out []fixture
	out = append(out, play(name+"/replay", "every page of the recording in wire order", append(applies(pages), step{Op: "view"}, step{Op: "inquiryOf", N: 1})))

	parts := sealedParts(pages)
	if len(parts) < 2 {
		return out
	}
	var turns []uint64
	for _, p := range parts {
		turns = append(turns, p.Parts[0].ID)
	}
	order := func(idx []int) []step {
		var s []step
		for _, i := range idx {
			p := parts[i]
			s = append(s, step{Op: "apply", Page: &p})
		}
		return s
	}
	n := len(parts)
	rev := make([]int, 0, n)
	for i := n - 1; i >= 0; i-- {
		rev = append(rev, i)
	}
	var evens, odds []int
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			evens = append(evens, i)
		} else {
			odds = append(odds, i)
		}
	}
	sparse := append(append([]int{}, evens...), odds...)
	{
		s := order(rev)
		s = append(s, windowSteps(turns)...)
		out = append(out, play(name+"/backward", "sealed turns arriving newest first", s))
	}
	{
		s := order(evens)
		s = append(s, windowSteps(turns)...)
		s = append(s, order(odds)...)
		s = append(s, windowSteps(turns)...)
		out = append(out, play(name+"/gappy", "every other turn first, then the holes, with queries over the holes", s))
	}
	{
		s := order(sparse)
		s = append(s, step{Op: "closedLimit", N: 1})
		s = append(s, windowSteps(turns)...)
		out = append(out, play(name+"/trimmed", "closed limit of one after a gappy build", s))
	}
	{
		s := order(rev)
		s = append(s, step{Op: "evictBefore", At: anchor(turns[len(turns)/2], 0)})
		s = append(s, windowSteps(turns)...)
		s = append(s, step{Op: "cloneBelow", N: int(turns[len(turns)-1])})
		s = append(s, windowSteps(turns)...)
		out = append(out, play(name+"/evicted-and-cloned", "evict the older half, then clone below the newest turn", s))
	}
	{
		s := order(evens)
		hi := turns[len(turns)-1]
		var fill []aria.Page
		for _, i := range odds {
			fill = append(fill, parts[i])
		}
		s = append(s, step{Op: "setMoreBefore", V: true})
		s = append(s, step{Op: "ensure", From: anchor(turns[0], 0), To: anchor(hi, 1<<40), Pages: fill})
		s = append(s, step{Op: "view"})
		out = append(out, play(name+"/ensure", "a fetcher closes every hole, one page per call", s))
	}
	{
		s := order(evens)
		hi := turns[len(turns)-1]
		s = append(s, step{Op: "ensure", From: anchor(turns[0], 0), To: anchor(hi, 1<<40), Pages: []aria.Page{parts[0]}})
		out = append(out, play(name+"/ensure-stalled", "a fetcher that keeps answering what is already held", s))
	}
	return out
}

func liveDelta(turn, from uint64, v int, id uint64, text string) aria.Page {
	return aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: turn, Live: &aria.Live{
		From: from, V: v,
		Nodes: []aria.NodeDelta{{ID: id, Set: map[string]any{"type": "prose", "role": "output", "markdown": text}}},
	}}}}}
}

func sealedPage(turn uint64, inquiry string, n int) aria.Page {
	t := wire.Turn{ID: turn, Sealed: true, Inquiry: inquiry}
	for i := 0; i < n; i++ {
		t.Nodes = append(t.Nodes, livedoc.Node{Type: livedoc.NodeProse, Role: livedoc.RoleOutput, Markdown: "x"})
	}
	return aria.Page{Parts: []aria.TurnPart{{Turn: t, From: 0}}}
}

func utf8Deltas() fixture {
	text := "señor 日本語 😀 end"
	patch := func(at, del int, ins string) wire.NodeDelta {
		return wire.NodeDelta{ID: 0, Patch: map[string]livedoc.Delta{"markdown": {At: at, Del: del, Ins: ins}}}
	}
	mk := func(v int, nd wire.NodeDelta) aria.Page {
		return aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 1, Live: &aria.Live{From: 0, V: v, Nodes: []wire.NodeDelta{nd}}}}}}
	}
	first := wire.NodeDelta{ID: 0, Set: map[string]any{"type": "prose", "role": "output", "markdown": text}}
	steps := []step{
		{Op: "apply", Page: ptr(mk(1, first))},
		{Op: "apply", Page: ptr(mk(2, patch(len(text), 0, "!")))},
		{Op: "apply", Page: ptr(mk(3, patch(2, 2, "ñ")))},
		{Op: "apply", Page: ptr(mk(4, patch(7, 6, "日")))},
		{Op: "apply", Page: ptr(mk(5, patch(1000, 5, "tail")))},
		{Op: "apply", Page: ptr(mk(6, patch(-3, 2, "head")))},
		{Op: "apply", Page: ptr(mk(7, wire.NodeDelta{ID: 0, Unset: []string{"markdown"}}))},
		{Op: "apply", Page: ptr(mk(8, wire.NodeDelta{ID: 0, Set: map[string]any{"markdown": "back", "status": "", "mystery": "x", "args": map[string]any{}}}))},
		{Op: "apply", Page: ptr(mk(9, wire.NodeDelta{ID: 2, Set: map[string]any{"type": "tool", "tool_call_id": "t1", "name": "bash", "status": "running", "args": map[string]any{"cmd": "ls"}, "input": "{\"cmd\":", "opened_at": 5, "lts": []any{1, 2}, "src": []any{map[string]any{"lt": 3, "block": 1}}}}))},
		{Op: "apply", Page: ptr(mk(10, wire.NodeDelta{ID: 2, Patch: map[string]livedoc.Delta{"output": {At: 0, Del: 0, Ins: "ok\n"}, "input": {At: 7, Del: 0, Ins: "\"ls\"}"}}}))},
		{Op: "apply", Page: ptr(mk(10, wire.NodeDelta{ID: 2, Set: map[string]any{"name": "stale"}}))},
		{Op: "apply", Page: ptr(mk(13, wire.NodeDelta{ID: 2, Set: map[string]any{"name": "skipped"}}))},
		{Op: "view"},
	}
	return play("deltas/fold-delta", "NodeDelta set, unset and byte-offset patches, a stale version and a skipped one", steps)
}

func ptr[T any](v T) *T { return &v }

func forkBirth() fixture {
	birth := map[string]livedoc.FormDelta{
		"a1.runtime.forked_from": {Value: json.RawMessage(`"90ec658474d50c8a"`), Kind: livedoc.FormBound, Event: livedoc.FormSet, Form: "a1"},
		"a1.mantra":              {Value: json.RawMessage(`"forked"`), Prev: json.RawMessage(`"trunk"`), Kind: livedoc.FormBound, Event: livedoc.FormSet, Form: "a1"},
	}
	opened := aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 2, Inquiry: "first question on the branch", FormDeltas: birth, ForkedFrom: "90ec658474d50c8a"}}}}
	sealed := sealedPage(2, "first question on the branch", 3)
	sealed.Parts[0].ForkedFrom = "90ec658474d50c8a"
	sealed.Parts[0].FormDeltas = birth
	plain := sealedPage(3, "an ordinary turn", 1)
	steps := []step{
		{Op: "apply", Page: &opened},
		{Op: "view"},
		{Op: "apply", Page: ptr(liveDelta(2, 0, 1, 0, "streaming"))},
		{Op: "view"},
		{Op: "apply", Page: &sealed},
		{Op: "apply", Page: &plain},
		{Op: "view"},
		{Op: "inquiryOf", N: 2},
		{Op: "inquiryOf", N: 3},
		{Op: "query", From: anchor(2, 1), To: anchor(2, 2)},
		{Op: "query", From: anchor(2, 0), To: anchor(2, 0)},
	}
	return play("synthetic/fork-birth", "a turn that opens a branch names its parent on the open and the sealed message, survives a slice at offset 0, and an ordinary turn names none", steps)
}

func synthetic() []fixture {
	var out []fixture
	{
		var s []step
		for turn := uint64(1); turn <= 6; turn++ {
			s = append(s, step{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: turn, Inquiry: "q"}}}})})
			for k := uint64(0); k < 3; k++ {
				s = append(s, step{Op: "apply", Page: ptr(liveDelta(turn, 0, int(k)+1, k, "streamed"))})
			}
			s = append(s, step{Op: "apply", Page: ptr(sealedPage(turn, "q", 3))})
		}
		s = append(s, windowSteps([]uint64{1, 2, 3, 4, 5, 6})...)
		out = append(out, play("synthetic/ordinary", "an aria nobody jumped around in is one range", s))
	}
	{
		s := []step{
			{Op: "apply", Page: ptr(liveDelta(1, 0, 1, 0, "first"))},
			{Op: "apply", Page: ptr(liveDelta(1, 0, 2, 1, "second"))},
			{Op: "apply", Page: ptr(liveDelta(1, 1, 3, 1, "second again"))},
			{Op: "view"},
			{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 1, Live: &aria.Live{From: 1, V: 3}}}}})},
			{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 1, Live: &aria.Live{From: 1, V: 9}}}}})},
			{Op: "apply", Page: ptr(sealedPage(1, "q", 2))},
			{Op: "view"},
		}
		out = append(out, play("synthetic/release-and-desync", "the head releases below Live.From; a close marker for a version never reached asks for a re-read", s))
	}
	{
		many := wire.Turn{ID: 1, Sealed: true, Inquiry: "q"}
		for i := 0; i < 5; i++ {
			many.Nodes = append(many.Nodes, livedoc.Node{Type: livedoc.NodeProse, Role: livedoc.RoleOutput, Markdown: strings.Repeat("é", 9000)})
		}
		s := []step{
			{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: many}}})},
			{Op: "view"},
			{Op: "query", From: anchor(1, 2), To: anchor(1, 5)},
		}
		out = append(out, play("synthetic/unit-split", "a sealed turn past 40000 bytes is split into several messages", s))
	}
	{
		s := []step{
			{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 3, Inquiry: "only a question", Sealed: true}}}}), Quiet: false},
			{Op: "apply", Page: ptr(aria.Page{Parts: []aria.TurnPart{{Turn: wire.Turn{ID: 1, Inquiry: "empty", Sealed: true}}}}), Quiet: false},
			{Op: "setTurnLen", N: 2, Len: 0},
			{Op: "view"},
			{Op: "query", From: anchor(1, 0), To: anchor(3, 0)},
			{Op: "apply", Page: ptr(sealedPage(2, "middle", 1)), Quiet: true},
			{Op: "query", From: anchor(1, 0), To: anchor(3, 0)},
		}
		out = append(out, play("synthetic/inquiry-only", "turns with no nodes occupy one anchor; an empty turn bridges two ranges", s))
	}
	out = append(out, forkBirth())
	out = append(out, utf8Deltas())
	return out
}

func main() {
	tapes := flag.String("tapes", "", "directory of tapes to replay (.tape from figaro listen --record, .ndjson from the daemon harness)")
	forms := flag.String("also", "", "a second directory of tapes")
	out := flag.String("out", "", "directory to write fixtures into")
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "-out is required")
		os.Exit(2)
	}
	var all []fixture
	for _, dir := range []string{*tapes, *forms} {
		if dir == "" {
			continue
		}
		paths, _ := filepath.Glob(filepath.Join(dir, "*"))
		sort.Strings(paths)
		for _, p := range paths {
			ext := filepath.Ext(p)
			if (ext != ".tape" && ext != ".ndjson") || strings.HasPrefix(filepath.Base(p), "fork-") {
				continue
			}
			pages, err := tapePages(p)
			if err != nil {
				fmt.Fprintln(os.Stderr, p, err)
				os.Exit(1)
			}
			if len(pages) == 0 {
				continue
			}
			all = append(all, scenarios(strings.TrimSuffix(filepath.Base(p), ext), pages)...)
		}
	}
	all = append(all, synthetic()...)
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, f := range all {
		path := filepath.Join(*out, strings.ReplaceAll(f.Name, "/", ".")+".json")
		b, err := json.Marshal(f)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	fmt.Printf("%d fixtures\n", len(all))
}
