const { extractChild } = require('../../../services/bookPipeline/input/normalizeRequest');

describe('normalizeRequest extractChild', () => {
  test('collects interests from child.interests', () => {
    const c = extractChild({
      child: { name: 'A', age: 4, anecdotes: {}, interests: ['trains', 'mud'] },
    });
    expect(c.interests).toEqual(['trains', 'mud']);
  });

  test('collects interests from top-level childInterests', () => {
    const c = extractChild({
      childInterests: ['bugs', 'bike'],
      child: { name: 'B', age: 5, anecdotes: {} },
    });
    expect(c.interests).toEqual(['bugs', 'bike']);
  });

  test('parses favorite_activities string from child when no array', () => {
    const c = extractChild({
      child: { name: 'C', age: 3, anecdotes: {}, favorite_activities: 'soccer; drawing' },
    });
    expect(c.interests).toEqual(['soccer', 'drawing']);
  });

  test('parses favorite_activities from top-level', () => {
    const c = extractChild({
      favorite_activities: 'swimming,\ncooking',
      child: { name: 'D', age: 6, anecdotes: {} },
    });
    expect(c.interests).toEqual(['swimming', 'cooking']);
  });

  test('sets appearance from child or top-level aliases', () => {
    expect(
      extractChild({
        child: { name: 'E', anecdotes: {}, childAppearance: ' curly hair ' },
      }).appearance,
    ).toBe('curly hair');
    expect(
      extractChild({
        childAppearance: 'blue glasses',
        child: { name: 'F', anecdotes: {} },
      }).appearance,
    ).toBe('blue glasses');
  });

  test('omits interests and appearance when absent', () => {
    const c = extractChild({
      child: { name: 'G', age: 2, gender: 'f', anecdotes: {} },
    });
    expect(c.interests).toBeUndefined();
    expect(c.appearance).toBeUndefined();
  });
});
