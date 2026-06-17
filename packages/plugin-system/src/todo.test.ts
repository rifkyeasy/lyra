import { describe, expect, it } from 'bun:test'
import { makeClarify, makeTodo } from './todo'

describe('todo', () => {
  it('add → list → update → list', async () => {
    const tool = makeTodo()
    const a = await tool.handler({ action: 'add', text: 'first task' })
    const b = await tool.handler({ action: 'add', text: 'second task' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const ids = [(a.data as { id: string }).id, (b.data as { id: string }).id]
    const upd = await tool.handler({ action: 'update', id: ids[0], status: 'completed' })
    expect(upd.ok).toBe(true)
    const list = await tool.handler({ action: 'list' })
    const tasks = (list.data as { tasks: { id: string; status: string }[] }).tasks
    expect(tasks).toHaveLength(2)
    expect(tasks.find(t => t.id === ids[0])!.status).toBe('completed')
    expect(tasks.find(t => t.id === ids[1])!.status).toBe('pending')
  })
  it('rejects update with unknown id', async () => {
    const tool = makeTodo()
    const out = await tool.handler({ action: 'update', id: '999', status: 'completed' })
    expect(out.ok).toBe(false)
  })
})

describe('clarify', () => {
  it('echoes the question and options', async () => {
    const tool = makeClarify()
    const out = await tool.handler({
      question: 'mainnet or testnet?',
      options: ['mainnet', 'testnet'],
    })
    expect(out.ok).toBe(true)
    const d = out.data as { question: string; options: string[] }
    expect(d.question).toBe('mainnet or testnet?')
    expect(d.options).toEqual(['mainnet', 'testnet'])
  })
})
