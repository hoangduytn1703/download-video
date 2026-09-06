import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DEPTH, deptDepth, rootDept, childrenOf, validateNewDept, addDept, renameDept, canRemoveDept, removeDept, isValidAssign, deptTree } from './tiktok-depts.js'

// Cây mẫu: công ty -> Marketing -> Team Video
const sample = [
  { id: 'c', name: 'Công ty', parentId: null },
  { id: 'm', name: 'Marketing', parentId: 'c' },
  { id: 'v', name: 'Team Video', parentId: 'm' },
]

test('deptDepth: công ty = 1, mỗi cấp +1', () => {
  assert.equal(deptDepth(sample, 'c'), 1)
  assert.equal(deptDepth(sample, 'm'), 2)
  assert.equal(deptDepth(sample, 'v'), 3)
})

test('rootDept + childrenOf', () => {
  assert.equal(rootDept(sample).id, 'c')
  assert.deepEqual(childrenOf(sample, 'c').map(d => d.id), ['m'])
  assert.deepEqual(childrenOf(sample, 'v').map(d => d.id), [])
})

test('validateNewDept: chỉ 1 cấp cao nhất (công ty)', () => {
  assert.equal(validateNewDept([], { name: 'Công ty' }).ok, true)
  const r = validateNewDept(sample, { name: 'Công ty 2' })
  assert.equal(r.ok, false)
  assert.match(r.message, /1 cấp cao nhất|công ty/i)
})

test('validateNewDept: tên trống / quá dài bị chặn', () => {
  assert.equal(validateNewDept(sample, { name: '  ', parentId: 'c' }).ok, false)
  assert.equal(validateNewDept(sample, { name: 'x'.repeat(61), parentId: 'c' }).ok, false)
})

test('validateNewDept: phòng cha phải tồn tại', () => {
  assert.equal(validateNewDept(sample, { name: 'X', parentId: 'khong-co' }).ok, false)
  assert.equal(validateNewDept(sample, { name: 'X', parentId: 'm' }).ok, true)
})

test(`validateNewDept: không quá ${MAX_DEPTH} cấp`, () => {
  // dựng cây sâu đúng MAX_DEPTH
  let depts = [{ id: 'l1', name: 'c', parentId: null }]
  for (let i = 2; i <= MAX_DEPTH; i++) depts.push({ id: 'l' + i, name: 'l' + i, parentId: 'l' + (i - 1) })
  assert.equal(deptDepth(depts, 'l' + MAX_DEPTH), MAX_DEPTH)
  const r = validateNewDept(depts, { name: 'quá sâu', parentId: 'l' + MAX_DEPTH })
  assert.equal(r.ok, false)
  assert.match(r.message, new RegExp(MAX_DEPTH + ' cấp'))
  // thêm vào cấp MAX_DEPTH-1 thì vẫn được
  assert.equal(validateNewDept(depts, { name: 'ok', parentId: 'l' + (MAX_DEPTH - 1) }).ok, true)
})

test('addDept / renameDept', () => {
  const after = addDept(sample, { id: 'k', name: 'Kinh doanh', parentId: 'c' })
  assert.equal(after.length, 4)
  assert.equal(renameDept(after, 'k', 'KD mới').find(d => d.id === 'k').name, 'KD mới')
})

test('canRemoveDept: chặn khi còn phòng con', () => {
  assert.equal(canRemoveDept(sample, 'm').ok, false, 'Marketing còn Team Video -> chặn')
  assert.equal(canRemoveDept(sample, 'v').ok, true, 'Team Video là lá -> xóa được')
  assert.equal(removeDept(sample, 'v').length, 2)
})

test('isValidAssign: null (bỏ nhóm) hoặc id tồn tại', () => {
  assert.equal(isValidAssign(sample, null), true)
  assert.equal(isValidAssign(sample, ''), true)
  assert.equal(isValidAssign(sample, 'm'), true)
  assert.equal(isValidAssign(sample, 'khong-co'), false)
})

test('deptTree: cây lồng nhau kèm depth', () => {
  const tree = deptTree(sample)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].id, 'c')
  assert.equal(tree[0].depth, 1)
  assert.equal(tree[0].children[0].id, 'm')
  assert.equal(tree[0].children[0].children[0].id, 'v')
  assert.equal(tree[0].children[0].children[0].depth, 3)
})
